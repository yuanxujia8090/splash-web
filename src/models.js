/**
 * Read-only scan of preferred local model directories.
 * Does NOT download. Reuses LM Studio / oMLX caches.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PREFERRED_MODEL_ROOTS = [
  path.join(os.homedir(), '.lmstudio', 'models'),
  path.join(os.homedir(), '.omlx', 'models'),
];

const SKIP_DIR_NAMES = new Set([
  '.locks',
  '.cache',
  '.pi',
  'blobs',
  'manifests',
  'assets',
  'node_modules',
  '.git',
]);

const MODEL_MARKERS = [
  'config.json',
  'model.safetensors',
  'model.safetensors.index.json',
  'tokenizer.json',
  'params.json',
];

/**
 * @param {string} dir
 */
function looksLikeModelDir(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some((e) => MODEL_MARKERS.includes(e))) return true;
    if (entries.some((e) => e.endsWith('.gguf'))) return true;
    if (entries.some((e) => e.endsWith('.safetensors'))) return true;
    // HF-style: many shards
    if (entries.some((e) => /^model-\d+-of-\d+\.safetensors$/.test(e))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Walk owner/repo (depth 2) under a root; also accept depth-1 model dirs.
 * @param {string} root
 * @param {string} source
 */
function scanRoot(root, source) {
  /** @type {{ path: string, label: string, source: string }[]} */
  const found = [];
  if (!fs.existsSync(root)) {
    return { root, source, exists: false, models: found };
  }

  let owners;
  try {
    owners = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { root, source, exists: true, error: err.message, models: found };
  }

  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    if (owner.name.startsWith('.') || SKIP_DIR_NAMES.has(owner.name)) continue;
    const ownerPath = path.join(root, owner.name);

    if (looksLikeModelDir(ownerPath)) {
      found.push({
        path: ownerPath,
        label: owner.name,
        source,
      });
      continue;
    }

    let repos;
    try {
      repos = fs.readdirSync(ownerPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      if (repo.name.startsWith('.') || SKIP_DIR_NAMES.has(repo.name)) continue;
      const repoPath = path.join(ownerPath, repo.name);
      if (looksLikeModelDir(repoPath)) {
        found.push({
          path: repoPath,
          label: `${owner.name}/${repo.name}`,
          source,
        });
      } else {
        // one more level for variant folders (optional)
        let variants;
        try {
          variants = fs.readdirSync(repoPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const v of variants) {
          if (!v.isDirectory()) continue;
          if (v.name.startsWith('.') || SKIP_DIR_NAMES.has(v.name)) continue;
          const vPath = path.join(repoPath, v.name);
          if (looksLikeModelDir(vPath)) {
            found.push({
              path: vPath,
              label: `${owner.name}/${repo.name}/${v.name}`,
              source,
            });
          }
        }
      }
    }
  }

  found.sort((a, b) => a.label.localeCompare(b.label));
  return { root, source, exists: true, models: found };
}

/**
 * List models from preferred roots (LM Studio first, then oMLX).
 */
export function listPreferredModels() {
  const roots = PREFERRED_MODEL_ROOTS.map((root, i) =>
    scanRoot(root, i === 0 ? 'lmstudio' : 'omlx'),
  );
  const models = roots.flatMap((r) => r.models);
  // de-dupe by real path
  const seen = new Set();
  const unique = [];
  for (const m of models) {
    let real = m.path;
    try {
      real = fs.realpathSync(m.path);
    } catch {
      /* keep */
    }
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push({ ...m, path: m.path });
  }
  return {
    preferredRoots: PREFERRED_MODEL_ROOTS,
    roots,
    models: unique,
    note: '不下载模型；复用 ~/.lmstudio/models 与 ~/.omlx/models。可手填其它本地路径。',
  };
}
