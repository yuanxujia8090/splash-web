/**
 * Whitelist of splash serve CLI flags exposed by splash-web.
 * No arbitrary shell; only these keys may become argv.
 */

/** @typedef {'string'|'number'|'boolean'|'enum'} FlagType */

/** @type {Record<string, { flag: string, type: FlagType, values?: string[], restart: boolean, label: string, help: string }>} */
export const FLAG_SPECS = {
  model: {
    flag: '--model',
    type: 'string',
    restart: true,
    label: '模型 (--model)',
    help: '本地目录或 OWNER/REPO[:VARIANT]；优先选 LM Studio / oMLX 已有路径',
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
  draftModel: {
    flag: '--draft-model',
    type: 'string',
    restart: true,
    label: 'Draft 模型',
    help: '可选；覆盖自动选择的 DFlash2 draft',
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
};

export const ALLOWED_CONFIG_KEYS = new Set(Object.keys(FLAG_SPECS));

const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
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
      // Block shell metacharacters that would only matter if someone later shells out;
      // we never use shell:true, but keep values conservative.
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
 * Build argv for `splash serve` from validated config. Never uses a shell.
 * @param {Record<string, unknown>} config
 * @returns {{ binary: string, args: string[], display: string }}
 */
export function buildServeArgv(config) {
  const binary =
    typeof config.splashBinary === 'string' && config.splashBinary
      ? config.splashBinary
      : 'splash';

  if (!config.model || typeof config.model !== 'string') {
    throw new Error('启动需要配置 model（--model）');
  }

  /** @type {string[]} */
  const args = ['serve', '--model', String(config.model)];

  // Public `port` is splash-web's listen port; Splash binds `upstreamPort`.
  const skip = new Set(['model', 'splashBinary', 'port', 'upstreamPort']);
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

  const upstream =
    Number.isInteger(Number(config.upstreamPort)) && Number(config.upstreamPort) >= 1
      ? Number(config.upstreamPort)
      : 18000;
  args.push('--port', String(upstream));

  // Force localhost bind if host omitted
  if (!config.host) {
    args.push('--host', '127.0.0.1');
  }

  const display = [binary, ...args].map(shellQuote).join(' ');
  return { binary, args, display };
}

function shellQuote(s) {
  if (/^[a-zA-Z0-9_./:@+=,-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
