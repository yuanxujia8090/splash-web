/**
 * 采样参数默认值（temperature / top_p / top_k）。
 *
 * 事实来源：Splash 1.4.0 `libexec/server/frontend.py`
 *   SAMPLING_NUMBERS = { temperature: 1.0, top_p: 0.95, ... }
 *   TOP_K_DEFAULT = 20
 * 这些值只在「请求体没带该字段」时生效，splash serve 没有对应 CLI flag。
 *
 * splash-web 因此改为在反代层补缺省：请求显式带了就不覆盖。
 */

/** 键名映射：config 字段 → OpenAI/Anthropic 请求字段 */
export const SAMPLING_FIELDS = [
  { configKey: 'temperature', wireKey: 'temperature', label: '温度' },
  { configKey: 'topP', wireKey: 'top_p', label: 'Top-P' },
  { configKey: 'topK', wireKey: 'top_k', label: 'Top-K' },
];

/** Splash 内置默认，用于管理页展示「不改也是这个值」 */
export const NATIVE_DEFAULTS = Object.freeze({
  temperature: 1.0,
  top_p: 0.95,
  top_k: 20,
});

/** 允许范围，仅用于展示；校验真源在 whitelist.js 的 FLAG_SPECS */
export const SAMPLING_RANGES = Object.freeze({
  temperature: '[0, 2]，0 = 贪心',
  top_p: '(0, 1]',
  top_k: '-1 或 0 = 关闭，或正整数',
});

/** 只有这些路径会做注入：它们都接受采样字段，别的路径塞进去会被 400 */
export const SAMPLING_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/v1/messages',
]);

/** 请求体超过这个字节数就放弃注入，直接流式转发（vision 请求可能几十 MB） */
export const SAMPLING_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * 是否需要对这次请求做注入。
 * @param {{ method?: string, path?: string, headers?: Record<string, unknown> }} reqLike
 */
export function shouldApplySampling(reqLike) {
  const method = String(reqLike.method || 'GET').toUpperCase();
  if (method !== 'POST') return false;
  if (!SAMPLING_PATHS.has(String(reqLike.path || ''))) return false;
  const rawType = reqLike.headers?.['content-type'];
  const contentType = String(Array.isArray(rawType) ? rawType[0] : rawType || '');
  return /^application\/(?:[\w.-]+\+)?json\b/i.test(contentType);
}

/**
 * 当前是否启用注入。默认开启，且默认值等于 Splash 原生默认 → 行为不变。
 * @param {{ applySamplingDefaults?: boolean }} config
 */
export function samplingEnabled(config) {
  return config?.applySamplingDefaults !== false;
}

/**
 * 本端要注入的值（只含配置里真的写了的项）。
 * @param {Record<string, unknown>} config
 * @returns {{ temperature?: number, top_p?: number, top_k?: number }}
 */
export function samplingDefaults(config) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const { configKey, wireKey } of SAMPLING_FIELDS) {
    const value = config?.[configKey];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[wireKey] = value;
    }
  }
  return out;
}

/**
 * 给请求体补缺省采样值。不覆盖客户端显式传的值（含显式 null）。
 * @template {Record<string, unknown>} T
 * @param {T} body
 * @param {Record<string, unknown>} config
 * @returns {{ body: T, applied: Record<string, number> }}
 */
export function applySamplingDefaults(body, config) {
  if (!samplingEnabled(config)) return { body, applied: {} };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { body, applied: {} };
  }

  /** @type {Record<string, number>} */
  const applied = {};
  for (const [wireKey, value] of Object.entries(samplingDefaults(config))) {
    if (Object.prototype.hasOwnProperty.call(body, wireKey)) continue;
    body[wireKey] = value;
    applied[wireKey] = value;
  }
  return { body, applied };
}

/**
 * 供管理页 / API 展示的说明块。
 * @param {Record<string, unknown>} config
 */
export function describeSampling(config) {
  return {
    enabled: samplingEnabled(config),
    effective: samplingDefaults(config),
    native: { ...NATIVE_DEFAULTS },
    ranges: { ...SAMPLING_RANGES },
    paths: [...SAMPLING_PATHS],
    maxBodyBytes: SAMPLING_MAX_BODY_BYTES,
    note:
      '这些值在 splash-web 反代时补进请求体；请求里显式写了的字段不会被覆盖。' +
      'Splash 本身没有对应的 CLI flag，所以改完不用重启 Splash。',
  };
}
