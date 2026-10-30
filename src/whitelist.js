/**
 * Whitelist of splash serve CLI flags exposed by splash-web.
 * No arbitrary shell; only these keys may become argv.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {'string'|'number'|'boolean'|'enum'} FlagType */

/** @type {Record<string, { flag: string|null, type: FlagType, values?: string[], restart: boolean, label: string, help: string }>} */
export const FLAG_SPECS = {
  model: {
    flag: '--model',
    type: 'string',
    restart: true,
    label: '模型 (--model)',
    help: '本地目录或 OWNER/REPO[:VARIANT]；本地目录会走 prepare_local_model，HF ID 走 splash serve',
  },
  port: {
    flag: null,
    type: 'number',
    restart: true,
    label: '对外端口',
    help: '对外端口（管理页在 /admin，Splash API/聊天经同一端口反代；默认 8000）',
  },
  upstreamPort: {
    flag: '--port',
    type: 'number',
    restart: true,
    label: '上游端口',
    help: '本端拉起的 Splash 实际监听端口（默认 18000；对外仍走 port 反代）',
  },
  host: {
    flag: '--host',
    type: 'string',
    restart: true,
    label: '绑定地址',
    help: '仅允许 127.0.0.1 或 localhost（管理端不做公网）',
  },
  maxMemory: {
    flag: '--max-memory',
    type: 'string',
    restart: true,
    label: '内存上限 (--max-memory)',
    help: '如 28G；只能降低自动预算',
  },
  maxContext: {
    flag: '--max-context',
    type: 'string',
    restart: true,
    label: '上下文上限 (--max-context)',
    help: '如 128K 或 1M',
  },
  queueSize: {
    flag: '--queue-size',
    type: 'number',
    restart: true,
    label: '队列容量 (--queue-size)',
    help: '同时接纳的请求数（默认 32）',
  },
  idleRelease: {
    flag: '--idle-release',
    type: 'string',
    restart: true,
    label: '空闲释放 (--idle-release)',
    help: '如 10m；off 表示不释放',
  },
  useDflash: {
    flag: null,
    type: 'boolean',
    restart: true,
    label: '启用 DFlash2 draft',
    help: '开启后启动时附带所选 draft；关闭则不强制（splash serve 仍可能自动选家族 draft）',
  },
  draftModel: {
    flag: '--draft-model',
    type: 'string',
    restart: true,
    label: 'DFlash2 draft (--draft-model)',
    help: '本地 DFlash2 目录或 HF owner/repo；仅在启用 DFlash2 时生效',
  },
  revision: {
    flag: '--revision',
    type: 'string',
    restart: true,
    label: 'Revision',
    help: 'HF 分支/tag/commit',
  },
  kvFormat: {
    flag: '--kv-format',
    type: 'enum',
    values: ['int8', 'bf16'],
    restart: true,
    label: 'KV 格式',
    help: 'int8 或 bf16',
  },
  stateFormat: {
    flag: '--state-format',
    type: 'enum',
    values: ['fp32', 'bf16'],
    restart: true,
    label: 'State 格式',
    help: 'fp32 或 bf16',
  },
  offline: {
    flag: '--offline',
    type: 'boolean',
    restart: true,
    label: '离线模式',
    help: '不访问 Hugging Face Hub',
  },
  languageOnly: {
    flag: '--language-only',
    type: 'boolean',
    restart: true,
    label: '仅语言',
    help: '跳过视觉加载',
  },
  noWebui: {
    flag: '--no-webui',
    type: 'boolean',
    restart: true,
    label: '禁用内置聊天页',
    help: '关闭 Splash 自带 chat UI',
  },
  servedModelName: {
    flag: '--served-model-name',
    type: 'string',
    restart: true,
    label: '对外模型名',
    help: 'API 额外 model 名',
  },
  maxRequestSize: {
    flag: '--max-request-size',
    type: 'string',
    restart: true,
    label: '请求体上限',
    help: '如 128M',
  },
  requestTimeout: {
    flag: '--request-timeout',
    type: 'string',
    restart: true,
    label: '请求超时',
    help: '如 30m',
  },
  splashBinary: {
    flag: null,
    type: 'string',
    restart: true,
    label: 'splash 可执行文件',
    help: '默认 /opt/homebrew/bin/splash 或 PATH 中的 splash',
  },

  // --- 采样参数：不是 CLI flag，只在反代补缺省（见 src/sampling.js）---
  applySamplingDefaults: {
    flag: null,
    type: 'boolean',
    restart: false,
    label: '启用采样默认值注入',
    help: '关闭后不补任何字段，完全交给客户端与 Splash 原生默认',
  },
  temperature: {
    flag: null,
    type: 'number',
    integer: false,
    min: 0,
    max: 2,
    restart: false,
    label: '温度 (temperature)',
    help: 'Splash 原生默认 1.0；范围 [0, 2]，0 为贪心',
  },
  topP: {
    flag: null,
    type: 'number',
    integer: false,
    min: 0,
    minExclusive: true,
    max: 1,
    restart: false,
    label: 'Top-P (top_p)',
    help: 'Splash 原生默认 0.95；范围 (0, 1]',
  },
  topK: {
    flag: null,
    type: 'number',
    min: -1,
    restart: false,
    label: 'Top-K (top_k)',
    help: 'Splash 原生默认 20；-1 或 0 关闭，或正整数',
  },
};

export const ALLOWED_CONFIG_KEYS = new Set(Object.keys(FLAG_SPECS));

const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Default local DFlash2 draft when present on Aaron's Mac / similar setups. */
export const DEFAULT_LOCAL_DRAFT = path.join(
  os.homedir(),
  '.omlx',
  'models',
  'z-lab',
  'Qwen3.8-27B-DFlash2',
);

/**
 * True when model looks like a local filesystem path (not owner/repo).
 * @param {unknown} model
 */
export function isLocalModelPath(model) {
  if (typeof model !== 'string' || !model) return false;
  const s = model.trim();
  if (!s) return false;
  // Absolute / home / relative filesystem paths
  if (s.startsWith('/') || s.startsWith('~') || s.startsWith('./') || s.startsWith('../')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  // HF owner/repo[:variant] is not a local path
  if (/^[^/\s]+\/[^/\s]+/.test(s)) return false;
  return false;
}

/**
 * @param {string} p
 */
export function expandUser(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Derive HF owner/repo from a local model directory path.
 * e.g. .../models/mlx-community/Qwen3.8-27B-4bit → mlx-community/Qwen3.8-27B-4bit
 * @param {string} modelPath
 */
export function deriveHfIdFromLocalPath(modelPath) {
  const expanded = path.resolve(expandUser(modelPath));
  const parts = expanded.split(path.sep).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`无法从本地路径推导 HF id：${modelPath}`);
  }
  const modelsIdx = parts.lastIndexOf('models');
  if (modelsIdx >= 0 && parts.length >= modelsIdx + 3) {
    return `${parts[modelsIdx + 1]}/${parts[modelsIdx + 2]}`;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Resolve Splash libexec next to a brew splash binary.
 * @param {string} [splashBinary]
 */
export function resolveSplashLibexec(splashBinary) {
  const candidates = [];
  if (splashBinary && typeof splashBinary === 'string') {
    const bin = expandUser(splashBinary);
    // /opt/homebrew/bin/splash → /opt/homebrew/opt/splash/libexec
    candidates.push(path.resolve(path.dirname(bin), '..', 'opt', 'splash', 'libexec'));
    // cellar: .../Cellar/splash/1.4.0/bin/splash → .../libexec (sibling of bin)
    candidates.push(path.resolve(path.dirname(bin), '..', 'libexec'));
  }
  candidates.push('/opt/homebrew/opt/splash/libexec');
  candidates.push('/usr/local/opt/splash/libexec');
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'python', 'bin', 'python3'))) return c;
    if (fs.existsSync(path.join(c, 'install', 'local.py'))) return c;
  }
  return candidates[0];
}

/**
 * Whether a path/name looks like a DFlash draft model.
 * @param {string} labelOrPath
 */
export function looksLikeDflash(labelOrPath) {
  return /dflash/i.test(String(labelOrPath || ''));
}

/**
 * Validate and normalize a partial config update.
 * Rejects unknown keys and unsafe values.
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, config: Record<string, unknown>, needsRestart: boolean } | { ok: false, error: string }}
 */
export function validateConfigPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置必须是对象' };
  }

  const unknown = Object.keys(input).filter((k) => !ALLOWED_CONFIG_KEYS.has(k));
  if (unknown.length) {
    return {
      ok: false,
      error: `拒绝危险/未知字段：${unknown.join(', ')}。只允许白名单：${[...ALLOWED_CONFIG_KEYS].join(', ')}`,
    };
  }

  /** @type {Record<string, unknown>} */
  const config = {};
  let needsRestart = false;

  for (const [key, raw] of Object.entries(input)) {
    const spec = FLAG_SPECS[key];
    if (raw === null || raw === undefined || raw === '') {
      continue;
    }

    if (spec.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        return { ok: false, error: `${key} 必须是布尔值` };
      }
      config[key] = raw;
    } else if (spec.type === 'number') {
      if (typeof raw !== 'number' && typeof raw !== 'string') {
        return { ok: false, error: `${key} 必须是数字` };
      }
      const n = typeof raw === 'number' ? raw : Number(raw);
      // 既有数字项（端口、队列）仍要求非负整数；采样项显式声明 integer:false
      const integer = spec.integer !== false;
      const min = spec.min ?? 0;
      const max = spec.max ?? null;
      const belowMin = spec.minExclusive ? n <= min : n < min;
      if (
        !Number.isFinite(n) ||
        (integer && !Number.isInteger(n)) ||
        belowMin ||
        (max !== null && n > max)
      ) {
        if (spec.min !== undefined || spec.max !== undefined) {
          const lo = spec.minExclusive ? `(${min}` : `[${min}`;
          return { ok: false, error: `${key} 必须在 ${lo}, ${max ?? '∞'}]` };
        }
        return { ok: false, error: `${key} 必须是非负整数` };
      }
      if ((key === 'port' || key === 'upstreamPort') && (n < 1 || n > 65535)) {
        return { ok: false, error: '端口必须在 1–65535' };
      }
      config[key] = n;
    } else if (spec.type === 'enum') {
      if (typeof raw !== 'string' || !spec.values.includes(raw)) {
        return { ok: false, error: `${key} 必须是 ${spec.values.join('|')}` };
      }
      config[key] = raw;
    } else {
      if (typeof raw !== 'string') {
        return { ok: false, error: `${key} 必须是字符串` };
      }
      if (raw.includes('\0') || /[\r\n]/.test(raw)) {
        return { ok: false, error: `${key} 含非法字符` };
      }
      if (/[;&|`$]/.test(raw)) {
        return { ok: false, error: `${key} 含禁止字符（;&|\`$）` };
      }
      if (key === 'host' && !LOCALHOST_HOSTS.has(raw)) {
        return {
          ok: false,
          error: `host 仅允许 127.0.0.1 / localhost / ::1（产品原则：不做公网管理）`,
        };
      }
      if ((key === 'model' || key === 'draftModel' || key === 'splashBinary') && raw.length > 1024) {
        return { ok: false, error: `${key} 过长` };
      }
      config[key] = raw;
    }

    if (spec.restart) needsRestart = true;
  }

  return { ok: true, config, needsRestart };
}

/**
 * Extra whitelist flags shared by splash serve and server.server (excluding model/draft/port wiring).
 * @param {Record<string, unknown>} config
 * @param {Set<string>} skip
 */
function appendWhitelistedFlags(config, skip, args) {
  for (const [key, value] of Object.entries(config)) {
    if (skip.has(key) || value === undefined || value === null || value === '') continue;
    const spec = FLAG_SPECS[key];
    if (!spec || !spec.flag) continue;
    if (spec.type === 'boolean') {
      if (value === true) args.push(spec.flag);
      continue;
    }
    args.push(spec.flag, String(value));
  }
}


/**
 * Append --allowed-origin for the public page Origin(s).
 * Browser Origin is the public port (e.g. :8000), not Splash upstream (:18000).
 * Defaults to http://127.0.0.1:<port> and http://localhost:<port> only — never *.
 * @param {Record<string, unknown>} config
 * @param {string[]} args
 */
export function appendAllowedOrigins(config, args) {
  const n = Number(config.port);
  const publicPort = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8000;
  for (const origin of [
    `http://127.0.0.1:${publicPort}`,
    `http://localhost:${publicPort}`,
  ]) {
    args.push('--allowed-origin', origin);
  }
}

function resolveUpstream(config) {
  return Number.isInteger(Number(config.upstreamPort)) && Number(config.upstreamPort) >= 1
    ? Number(config.upstreamPort)
    : 18000;
}

/**
 * Build argv for `splash serve` (HF owner/repo path only). Prefer buildLaunchPlan for start.
 * @param {Record<string, unknown>} config
 * @returns {{ binary: string, args: string[], display: string }}
 */
export function buildServeArgv(config) {
  const plan = buildLaunchPlan(config, { prepareLocal: false });
  return { binary: plan.binary, args: plan.args, display: plan.display };
}

/**
 * Full launch plan: HF id → splash serve; local path → python -m server.server (after prepare).
 * @param {Record<string, unknown>} config
 * @param {{ prepareLocal?: boolean, preparedDir?: string }} [opts]
 */
export function buildLaunchPlan(config, opts = {}) {
  if (!config.model || typeof config.model !== 'string') {
    throw new Error('启动需要配置 model（--model）');
  }

  const useDflash = config.useDflash === true;
  const draftRaw =
    useDflash && typeof config.draftModel === 'string' && config.draftModel.trim()
      ? config.draftModel.trim()
      : '';
  const draftNote = useDflash
    ? draftRaw
      ? `DFlash2 已启用，draft=${draftRaw}`
      : 'DFlash2 已启用但未选 draft：splash serve 将按家族自动选；本地 prepare 不传 draft='
    : 'DFlash2 关闭：不强制 --draft-model / draft=（splash serve 仍可能自动选家族 draft）';

  const local = isLocalModelPath(config.model);
  const upstream = resolveUpstream(config);
  const splashBinary =
    typeof config.splashBinary === 'string' && config.splashBinary
      ? config.splashBinary
      : 'splash';

  if (!local) {
    /** @type {string[]} */
    const args = ['serve', '--model', String(config.model)];
    const skip = new Set([
      'model',
      'splashBinary',
      'port',
      'upstreamPort',
      'useDflash',
      'draftModel',
    ]);
    appendWhitelistedFlags(config, skip, args);
    if (useDflash && draftRaw) {
      args.push('--draft-model', draftRaw);
    }
    args.push('--port', String(upstream));
    if (!config.host) {
      args.push('--host', '127.0.0.1');
    }
    appendAllowedOrigins(config, args);
    const display = [splashBinary, ...args].map(shellQuote).join(' ');
    return {
      mode: 'serve',
      binary: splashBinary,
      args,
      display,
      env: {},
      modelId: String(config.model),
      localPath: null,
      preparedDir: null,
      draft: useDflash && draftRaw ? draftRaw : null,
      useDflash,
      draftNote,
      libexec: resolveSplashLibexec(splashBinary),
    };
  }

  const localPath = path.resolve(expandUser(String(config.model)));
  if (!fs.existsSync(localPath)) {
    throw new Error(`本地模型目录不存在：${localPath}`);
  }
  const modelId = deriveHfIdFromLocalPath(localPath);
  const libexec = resolveSplashLibexec(splashBinary);
  const python = path.join(libexec, 'python', 'bin', 'python3');
  const engine = path.join(libexec, 'engine', 'splash');
  const preparedDir =
    typeof opts.preparedDir === 'string' && opts.preparedDir
      ? opts.preparedDir
      : '<prepared-after-prepare_local_model>';

  /** @type {string[]} */
  const args = [
    '-u',
    '-P',
    '-m',
    'server.server',
    preparedDir,
    '--model',
    modelId,
    '--binary',
    engine,
  ];
  // server.server has no --draft-model / --revision / --language-only / --offline
  // (draft baked at prepare). Skip those + admin-only keys.
  const skip = new Set([
    'model',
    'splashBinary',
    'port',
    'upstreamPort',
    'useDflash',
    'draftModel',
    'revision',
    'offline',
    'languageOnly',
  ]);
  appendWhitelistedFlags(config, skip, args);
  args.push('--port', String(upstream));
  if (!config.host) {
    args.push('--host', '127.0.0.1');
  }
  appendAllowedOrigins(config, args);

  const display = [
    `PYTHONPATH=${libexec}`,
    python,
    ...args,
  ]
    .map(shellQuote)
    .join(' ');

  return {
    mode: 'local',
    binary: python,
    args,
    display,
    env: {
      PYTHONPATH: libexec,
      PYTHONUNBUFFERED: '1',
      TRANSFORMERS_VERBOSITY: 'error',
    },
    modelId,
    localPath,
    preparedDir: opts.preparedDir || null,
    draft: useDflash && draftRaw ? expandUser(draftRaw) : null,
    useDflash,
    draftNote,
    libexec,
    needsPrepare: opts.prepareLocal !== false,
  };
}

function shellQuote(s) {
  if (/^[a-zA-Z0-9_./:@+=,-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
