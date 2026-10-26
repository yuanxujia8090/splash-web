import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_SPECS, validateConfigPatch, buildServeArgv } from './whitelist.js';
import { loadConfig, saveConfig, configPath, DEFAULT_CONFIG } from './config.js';
import { listPreferredModels, PREFERRED_MODEL_ROOTS } from './models.js';
import {
  ownershipStatus,
  previewCommand,
  startManaged,
  stopManaged,
  restartManaged,
  dryRunEnabled,
} from './process-manager.js';
import { probeSplash } from './splash-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const ADMIN_HOST = process.env.SPLASH_WEB_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.SPLASH_WEB_PORT || 8787);

const app = express();
app.use(express.json({ limit: '64kb' }));

// Bind admin UI only on loopback by default
app.use((req, res, next) => {
  res.setHeader('X-Splash-Web', '1');
  next();
});

app.get('/api/meta', (_req, res) => {
  res.json({
    name: 'splash-web',
    version: '0.1.0',
    admin: { host: ADMIN_HOST, port: ADMIN_PORT },
    configPath: configPath(),
    preferredModelRoots: PREFERRED_MODEL_ROOTS,
    dryRun: dryRunEnabled(),
    license: 'Apache-2.0',
    principles: [
      'localhost only',
      'whitelist CLI flags only — no general shell',
      'reuse ~/.lmstudio/models and ~/.omlx/models — no download',
      'manage only processes spawned by this admin',
    ],
  });
});

app.get('/api/flags', (_req, res) => {
  res.json({ flags: FLAG_SPECS, defaults: DEFAULT_CONFIG });
});

app.get('/api/config', (_req, res) => {
  const config = loadConfig();
  let command = null;
  try {
    command = buildServeArgv(config).display;
  } catch (err) {
    command = null;
  }
  res.json({
    config,
    path: configPath(),
    needsRestartHint: '修改配置后需重启 Splash 才生效',
    previewCommand: command,
  });
});

app.put('/api/config', (req, res) => {
  const patchResult = validateConfigPatch(req.body || {});
  if (!patchResult.ok) {
    return res.status(400).json(patchResult);
  }
  const saved = saveConfig(req.body || {});
  if (!saved.ok) {
    return res.status(400).json(saved);
  }
  let preview = null;
  try {
    preview = buildServeArgv(saved.config).display;
  } catch {
    preview = null;
  }
  res.json({ ...saved, previewCommand: preview });
});

app.get('/api/models', (_req, res) => {
  res.json(listPreferredModels());
});

app.get('/api/status', async (_req, res) => {
  const config = loadConfig();
  const ownership = await ownershipStatus(config);
  const probe = ownership.probe;
  res.json({
    configTarget: { host: config.host, port: config.port, model: config.model },
    ownership: {
      kind: ownership.kind,
      managedPid: ownership.managedPid,
      canRestart: ownership.canRestart,
      message: ownership.message,
    },
    probe: {
      baseUrl: probe.baseUrl,
      reachable: probe.reachable,
      ready: probe.ready,
      error: probe.error,
      summary: probe.summary,
    },
    dryRun: dryRunEnabled(),
    previewCommand: previewCommand(config).display,
  });
});

app.get('/api/preview-command', (_req, res) => {
  const config = loadConfig();
  try {
    res.json(previewCommand(config));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/start', async (_req, res) => {
  const result = await startManaged(loadConfig());
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/stop', async (_req, res) => {
  const ownership = await ownershipStatus(loadConfig());
  if (ownership.kind === 'external') {
    return res.status(400).json({
      ok: false,
      error: ownership.message,
    });
  }
  const result = await stopManaged();
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/restart', async (_req, res) => {
  const result = await restartManaged(loadConfig());
  res.status(result.ok ? 200 : 400).json(result);
});

app.use(express.static(path.join(ROOT, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const server = app.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.log(`[splash-web] admin http://${ADMIN_HOST}:${ADMIN_PORT}`);
  console.log(`[splash-web] config ${configPath()}`);
  console.log(`[splash-web] dryRun=${dryRunEnabled()}`);
  console.log(`[splash-web] model roots: ${PREFERRED_MODEL_ROOTS.join(', ')}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[splash-web] 管理端端口 ${ADMIN_PORT} 已被占用。请设置 SPLASH_WEB_PORT=其它端口 后重试。`,
    );
  } else {
    console.error('[splash-web]', err);
  }
  process.exit(1);
});
