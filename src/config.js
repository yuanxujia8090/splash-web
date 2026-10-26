import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateConfigPatch } from './whitelist.js';

const DEFAULT_CONFIG = {
  model: '',
  port: 8000,
  host: '127.0.0.1',
  maxMemory: '',
  maxContext: '',
  queueSize: 32,
  idleRelease: '',
  offline: false,
  languageOnly: false,
  noWebui: false,
  splashBinary: '/opt/homebrew/bin/splash',
};

export function configDir() {
  return process.env.SPLASH_WEB_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'splash-web');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

export function runtimeDir() {
  return process.env.SPLASH_WEB_RUNTIME_DIR || configDir();
}

export function pidPath() {
  return path.join(runtimeDir(), 'splash.pid');
}

export function managedMetaPath() {
  return path.join(runtimeDir(), 'managed.json');
}

export function ensureDirs() {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.mkdirSync(runtimeDir(), { recursive: true });
}

export function loadConfig() {
  ensureDirs();
  const p = configPath();
  if (!fs.existsSync(p)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...raw };
    const result = validateConfigPatch(merged);
    if (!result.ok) {
      console.warn('[splash-web] config invalid, using defaults:', result.error);
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...result.config };
  } catch (err) {
    console.warn('[splash-web] failed to read config:', err.message);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * @param {Record<string, unknown>} patch
 */
export function saveConfig(patch) {
  ensureDirs();
  const current = loadConfig();
  const merged = { ...current, ...patch };
  // Clear empty strings for optional fields by keeping them as ''
  const result = validateConfigPatch(merged);
  if (!result.ok) return result;

  const toWrite = { ...DEFAULT_CONFIG, ...result.config };
  // Preserve keys that validate skipped (empty) — apply patch empties
  for (const key of Object.keys(patch)) {
    if (patch[key] === '' || patch[key] === null) {
      if (typeof DEFAULT_CONFIG[key] === 'boolean') toWrite[key] = false;
      else if (typeof DEFAULT_CONFIG[key] === 'number') toWrite[key] = DEFAULT_CONFIG[key];
      else toWrite[key] = '';
    }
  }

  const finalCheck = validateConfigPatch(toWrite);
  if (!finalCheck.ok) return finalCheck;

  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...DEFAULT_CONFIG, ...finalCheck.config }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configPath());

  return {
    ok: true,
    config: { ...DEFAULT_CONFIG, ...finalCheck.config },
    needsRestart: true,
    path: configPath(),
    message: '配置已保存。需重启 Splash 服务后才会生效。',
  };
}

export { DEFAULT_CONFIG };
