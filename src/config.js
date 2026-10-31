import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateConfigPatch } from './whitelist.js';

const DEFAULT_CONFIG = {
  model: '',
  port: 8000,
  upstreamPort: 18000,
  host: '127.0.0.1',
  maxMemory: '',
  maxContext: '',
  // 思考等级：--default-reasoning-effort（none/minimal/low/medium/high/xhigh/max）。
  // 空串 = 不传该 flag，沿用 Splash 模型模板的默认。
  reasoningEffort: '',
  queueSize: 32,
  idleRelease: '',
  useDflash: true,
  draftModel: '',
  offline: false,
  languageOnly: false,
  noWebui: false,
  splashBinary: '/opt/homebrew/bin/splash',
  // 采样默认值：只在客户端请求缺该字段时补进请求体（见 src/sampling.js）。
  // 默认值与 Splash 内置默认一致，所以默认开开关也不会改变行为。
  applySamplingDefaults: true,
  temperature: 1.0,
  topP: 0.95,
  topK: 20,
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

/**
 * Public (admin + reverse-proxy) listen port.
 * Env SPLASH_WEB_PORT wins over config.port.
 */
export function resolvePublicPort(config = loadConfig()) {
  if (process.env.SPLASH_WEB_PORT) {
    const n = Number(process.env.SPLASH_WEB_PORT);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  const n = Number(config.port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8000;
}

/**
 * Managed Splash upstream port (never the public admin port).
 * Env SPLASH_WEB_UPSTREAM_PORT wins over config.upstreamPort.
 */
export function resolveUpstreamPort(config = loadConfig()) {
  if (process.env.SPLASH_WEB_UPSTREAM_PORT) {
    const n = Number(process.env.SPLASH_WEB_UPSTREAM_PORT);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  const n = Number(config.upstreamPort);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 18000;
}

function withDraftDefaults(config) {
  const out = { ...config };
  if (!out.draftModel) {
    try {
      // lazy import avoided: resolve default draft path inline
      const home = os.homedir();
      const draft = path.join(home, '.omlx', 'models', 'z-lab', 'Qwen3.8-27B-DFlash2');
      if (fs.existsSync(draft)) out.draftModel = draft;
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function loadConfig() {
  ensureDirs();
  const p = configPath();
  if (!fs.existsSync(p)) {
    return withDraftDefaults({ ...DEFAULT_CONFIG });
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = { ...DEFAULT_CONFIG, ...raw };
    const result = validateConfigPatch(merged);
    if (!result.ok) {
      console.warn('[splash-web] config invalid, using defaults:', result.error);
      return withDraftDefaults({ ...DEFAULT_CONFIG });
    }
    return withDraftDefaults({ ...DEFAULT_CONFIG, ...result.config });
  } catch (err) {
    console.warn('[splash-web] failed to read config:', err.message);
    return withDraftDefaults({ ...DEFAULT_CONFIG });
  }
}

/**
 * @param {Record<string, unknown>} patch
 */
export function saveConfig(patch) {
  ensureDirs();
  const current = loadConfig();
  const merged = { ...current, ...patch };
  const result = validateConfigPatch(merged);
  if (!result.ok) return result;

  const toWrite = { ...DEFAULT_CONFIG, ...result.config };
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
    needsRestart: finalCheck.needsRestart === true,
    samplingImmediate: true,
    path: configPath(),
    message: finalCheck.needsRestart
      ? '配置已保存。采样参数下次请求即生效；其它项需重启 Splash 才生效。'
      : '配置已保存，即时生效。',
  };
}

export { DEFAULT_CONFIG };
