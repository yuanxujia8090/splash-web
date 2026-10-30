/**
 * 速度测量：算法对齐 https://github.com/gsanhueza/pi-token-speed
 *
 * pi-token-speed 在客户端按「时间滑动窗口」算 TPS，规则是：
 *   1. 默认 1000ms 窗口（配置项 slidingWindow）
 *   2. 速度 = 窗口内 token 数 / 窗口内实际时间跨度
 *   3. 时间跨度最少按 100ms 算，避免「憋一会再一次性吐出来」把速度算爆
 *   4. 窗口内没有新增 token 时，显示整段平均（配置项 endTpsBehavior: "average"）
 *
 * Splash 只对外给累计计数（decode_output_tokens / prefill_input_tokens），
 * 所以这里按固定间隔采样累计值，用相邻样本做差分，得到同一口径的窗口速度。
 * 采样间隔即窗口粒度，默认 1s，与 pi-token-speed 默认窗口一致。
 */

/** 默认窗口（ms），对应 pi-token-speed 的 slidingWindow = 1000。 */
const DEFAULT_WINDOW_MS = 1000;

/** 时间跨度下限（ms），对应 pi-token-speed 的 MIN_SLIDING_WINDOW。 */
export const MIN_SPAN_MS = 100;

/** 采样间隔（ms），跟窗口等长，一个窗口约 1~2 个采样点。 */
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

/** 环形缓冲上限（样本数），1s 一个即 3 分钟历史。 */
const MAX_SAMPLES = 180;

/** 无人读状态后多久停止采样（ms），避免管理页关掉还一直打上游。 */
const DEFAULT_IDLE_STOP_MS = 60_000;

/**
 * 把任意值收敛成有限数字；其它一律 null（不猜 0，0 是有效速度）。
 * @param {unknown} value
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 /status 里取速度要用的累计计数器。
 * 字段见 Splash 1.4.0 libexec/server/metrics.py（PROMETHEUS_SERIES）。
 *
 * tokens 用于滑动窗口；*WallMs 用于自己累计平均速度（只算引擎真正干活的时间，
 * 不把空闲时间计入分母）。
 *
 * @param {any} status
 * @returns {{ decode: number|null, prefill: number|null,
 *   decodeWallMs: number|null, prefillWallMs: number|null }}
 */
export function readSpeedCounters(status) {
  const metrics = status?.metrics || {};
  return {
    decode: finiteNumber(metrics.decode_output_tokens),
    prefill: finiteNumber(metrics.prefill_input_tokens),
    decodeWallMs: finiteNumber(metrics.decode_wall_ms),
    prefillWallMs: finiteNumber(metrics.prefill_wall_ms),
  };
}

/**
 * 累计平均速度：自己把上游的累计计数加总，跨 Splash 重启不清零。
 *
 * 为什么不用 Splash 上报的 `*_tokens_per_second`：那是上游进程自己的
 * 累计值，Splash 一重启就归零。这里把增量存在本地（可持久化到磁盘），
 * 重启 Splash 只丢一轮增量，历史总量保留。
 */
export class SpeedTotals {
  /** @param {any} [state] 持久化过的状态（toJSON 的产物） */
  constructor(state = null) {
    this.decodeTokens = Number(state?.decodeTokens) || 0;
    this.decodeWallMs = Number(state?.decodeWallMs) || 0;
    this.prefillTokens = Number(state?.prefillTokens) || 0;
    this.prefillWallMs = Number(state?.prefillWallMs) || 0;
    /** 上一次上游读数，用来算增量 */
    this.last = state?.last ?? null;
  }

  /**
   * 吃进一份 /status。返回是否有有效变化。
   * @param {any} status
   */
  ingest(status) {
    const cur = readSpeedCounters(status);
    if (cur.decode === null && cur.prefill === null) return false;

    // 首次跑：直接采信上游已有的历史累计，否则平均值会从 0 重算而偏低
    if (!this.last) {
      this.decodeTokens = cur.decode ?? 0;
      this.decodeWallMs = cur.decodeWallMs ?? 0;
      this.prefillTokens = cur.prefill ?? 0;
      this.prefillWallMs = cur.prefillWallMs ?? 0;
      this.last = cur;
      return true;
    }

    const dDecodeTokens = cur.decode !== null && this.last.decode !== null
      ? cur.decode - this.last.decode
      : null;
    const dDecodeWall = cur.decodeWallMs !== null && this.last.decodeWallMs !== null
      ? cur.decodeWallMs - this.last.decodeWallMs
      : null;
    // 负数 = 上游重启后计数归零，这一轮丢掉，历史累计不清零
    if (dDecodeTokens !== null && dDecodeWall !== null && dDecodeTokens >= 0 && dDecodeWall >= 0) {
      this.decodeTokens += dDecodeTokens;
      this.decodeWallMs += dDecodeWall;
    }

    const dPrefillTokens = cur.prefill !== null && this.last.prefill !== null
      ? cur.prefill - this.last.prefill
      : null;
    const dPrefillWall = cur.prefillWallMs !== null && this.last.prefillWallMs !== null
      ? cur.prefillWallMs - this.last.prefillWallMs
      : null;
    if (dPrefillTokens !== null && dPrefillWall !== null && dPrefillTokens >= 0 && dPrefillWall >= 0) {
      this.prefillTokens += dPrefillTokens;
      this.prefillWallMs += dPrefillWall;
    }

    this.last = cur;
    return true;
  }

  /**
   * 手动重置：累计量归零，同时把上游当前读数记成基线。
   * 不记基线的话，下一轮 ingest 会当成「首次运行」，
   * 把上游历史累计又采信回来，重置就白做了。
   *
   * @param {any} [status] 当前上游 status（拿不到就先清空，下一轮再对齐）
   */
  reset(status = null) {
    this.decodeTokens = 0;
    this.decodeWallMs = 0;
    this.prefillTokens = 0;
    this.prefillWallMs = 0;
    this.last = status && typeof status === 'object' ? readSpeedCounters(status) : null;
    return this;
  }

  /** 累计平均速度（tok/s）；没有引擎时间就没有值。 */
  snapshot() {
    return {
      decodeTokPerSec:
        this.decodeWallMs > 0 ? (this.decodeTokens * 1000) / this.decodeWallMs : null,
      prefillTokPerSec:
        this.prefillWallMs > 0 ? (this.prefillTokens * 1000) / this.prefillWallMs : null,
      decodeTokens: this.decodeTokens,
      prefillTokens: this.prefillTokens,
      decodeWallMs: this.decodeWallMs,
      prefillWallMs: this.prefillWallMs,
    };
  }

  toJSON() {
    return {
      decodeTokens: this.decodeTokens,
      decodeWallMs: this.decodeWallMs,
      prefillTokens: this.prefillTokens,
      prefillWallMs: this.prefillWallMs,
      last: this.last,
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * 时间滑动窗口速度。
 *
 * 与 pi-token-speed 的 SlidingWindow.getTps 同一公式：
 *   1000 * 窗口内 token 增量 / 时间跨度
 * 差别只在于「事件」是采样点而非逐 token，因此时间跨度取
 * 「最后一个采样点 - 基准采样点」，并把跨度压到不低于 100ms。
 *
 * @param {{ time: number, counters: { decode: number|null, prefill: number|null } }[]} samples 时间升序
 * @param {'decode'|'prefill'} key
 * @param {number} now 当前时间（ms）
 * @param {{ windowMs?: number, minSpanMs?: number }} [options]
 * @returns {number|null} 速度；样本不足或计数器缺失时返回 null（区分「没有数据」和「速度是 0」）
 */
export function windowRate(samples, key, now, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const minSpanMs = options.minSpanMs ?? MIN_SPAN_MS;

  if (!Array.isArray(samples) || samples.length < 2) return null;

  const last = samples.at(-1);
  const cutoff = now - windowMs;
  if (last.time < cutoff) return null; // 采样已过期，窗口里没有可信数据

  // 窗口内第一个采样点
  let first = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].time >= cutoff) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;

  // 用窗口前一个采样点当基准，保证差分覆盖整个窗口（与 pi-token-speed
  // 的「窗口起点」处理一致：起点落在窗口外沿，不是第一笔事件本身）。
  const base = samples[first > 0 ? first - 1 : first];
  if (base === last) return null;

  const startTokens = base.counters?.[key];
  const endTokens = last.counters?.[key];
  if (startTokens === null || startTokens === undefined) return null;
  if (endTokens === null || endTokens === undefined) return null;

  const tokens = endTokens - startTokens;
  if (!Number.isFinite(tokens) || tokens < 0) return null; // 负数 = 计数器被重置（Splash 重启），当轮不报

  const span = Math.max(last.time - base.time, minSpanMs);
  return (1000 * tokens) / span;
}

/**
 * 上游此刻是否有请求在跑。判定口径跟 summarizeStatus 里统计 active 的一致。
 * @param {any} status
 */
function isStatusBusy(status) {
  if (!status || typeof status !== 'object') return false;
  const scheduler = status.scheduler || {};
  const httpStatus = status.http || {};
  const activeList = Array.isArray(status.active_requests) ? status.active_requests : [];
  const active =
    activeList.length ||
    Number(httpStatus.requests?.active) ||
    Number(scheduler.prefilling) + Number(scheduler.decode_batches) ||
    0;
  return active > 0;
}

/**
 * 汇总一次展示用的速度。
 *
 * 取数优先级对齐 pi-token-speed：
 *   - 窗口里确实在产出 token → 窗口速度（实时）
 *   - 窗口里没产出 → 整段平均（endTpsBehavior: "average"），即 Splash 的累计速率
 *   - 两边都没有 → null，由调用方显示「—」
 *
 * @param {{
 *   samples?: { time: number, counters: { decode: number|null, prefill: number|null } }[],
 *   status?: any,
 *   totals?: { decodeTokPerSec: number|null, prefillTokPerSec: number|null } | null,
 *   now?: number,
 *   windowMs?: number,
 *   minSpanMs?: number,
 * }} [input]
 */
export function summarizeSpeed(input = {}) {
  const samples = input.samples ?? [];
  const status = input.status ?? null;
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const minSpanMs = input.minSpanMs ?? MIN_SPAN_MS;

  const lastTime = samples.length ? samples.at(-1).time : 0;
  // 采样停了两个窗口以上就当没有窗口数据，避免拿旧数字一直显示
  const fresh = samples.length > 0 && now - lastTime <= Math.max(windowMs * 2, 2 * MIN_SPAN_MS);

  const decodeWindow = fresh ? windowRate(samples, 'decode', now, { windowMs, minSpanMs }) : null;
  const prefillWindow = fresh ? windowRate(samples, 'prefill', now, { windowMs, minSpanMs }) : null;

  const metrics = status?.metrics || {};
  // 有自累计对象时就用它（哪怕还是空的）；只在没接入 totals 时才回退
  // 上游自报值 —— 否则刚点了「刷新」，平均会冒出一个历史累计值。
  const totals = input.totals ?? null;
  const decodeAverage = totals
    ? (totals.decodeTokPerSec ?? null)
    : finiteNumber(metrics.decode_tokens_per_second);
  const prefillAverage = totals
    ? (totals.prefillTokPerSec ?? null)
    : finiteNumber(metrics.prefill_tokens_per_second);
  const busy = isStatusBusy(status);

  // 取数规则对齐 pi-token-speed：
  //   - 有活跃请求：窗口值就是真值（含 0）。窗口 0 说明真的卡了，
  //     不能拿历史平均盖过去，否则「卡了」看起来像「在算」。
  //   - 空闲：窗口有产出就显示窗口（刚结束那一瞬间），否则显示累计平均（机器能力）。
  const resolveSpeed = (windowValue, averageValue) => {
    if (windowValue !== null && (windowValue > 0 || busy)) {
      return { value: windowValue, source: 'window' };
    }
    if (averageValue !== null) return { value: averageValue, source: 'average' };
    return { value: windowValue, source: 'none' };
  };

  const decode = resolveSpeed(decodeWindow, decodeAverage);
  const prefill = resolveSpeed(prefillWindow, prefillAverage);

  return {
    decodeTokPerSec: decode.value,
    prefillTokPerSec: prefill.value,
    // Splash 上报的累计平均值，UI 拿它在实时值旁边做对照
    decodeAverageTokPerSec: decodeAverage,
    prefillAverageTokPerSec: prefillAverage,
    // 两个数字可能不同源：decode 有实时产出、prefill 只取到历史平均。
    decodeSource: decode.source,
    prefillSource: prefill.source,
    // 累计量，便于排查「平均是不是真的重置了」
    decodeTokens: totals?.decodeTokens ?? null,
    prefillTokens: totals?.prefillTokens ?? null,
    // 只含窗口实时值（null = 窗口里没产出）。判断「是不是在算」用它，
    // 别用带回退的平均值，否则空闲时也会被历史平均点亮。
    decodeWindowTokPerSec: decodeWindow,
    prefillWindowTokPerSec: prefillWindow,
    // window = 实时窗口；average = 回退到累计平均；none = 两边都没数
    // source 沿用 decode 的来源，供旧调用方兼容。
    source: decode.source,
    windowMs,
    samples: samples.length,
  };
}

/**
 * 后台采样器：定时拉 /status，把累计计数变成时间序列。
 *
 * 生命周期由 UI 驱动：有人读状态就 start（touch），
 * 超过 idleStopMs 没人读就停，避免管理页关掉后还在轮询上游。
 */
export class SpeedSampler {
  constructor(options = {}) {
    this.fetchStatus = options.fetchStatus ?? null;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.minSpanMs = options.minSpanMs ?? MIN_SPAN_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    this.maxSamples = options.maxSamples ?? MAX_SAMPLES;
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    // 累计平均值（跨 Splash 重启不清零），initialTotals 来自磁盘
    this.totals = new SpeedTotals(options.initialTotals ?? null);
    this.persist = options.persist ?? null;

    /** @type {{ time: number, counters: { decode: number|null, prefill: number|null } }[]} */
    this.samples = [];
    this.lastStatus = null;
    this.timer = null;
    this.polling = false;
    // null = 还没人读过状态（时钟从 0 开始也算有效读数，不能用 0 当哨兵）
    this.lastAccess = null;
  }

  get running() {
    return this.timer !== null;
  }

  /**
   * 记一笔样本（供 poll 和「本次 /status 已经拿到原始 status」两条路径共用）。
   * @param {any} status
   */
  record(status) {
    if (!status || typeof status !== 'object') return null;
    this.lastStatus = status;
    this.samples.push({ time: this.now(), counters: readSpeedCounters(status) });
    const overflow = this.samples.length - this.maxSamples;
    if (overflow > 0) this.samples.splice(0, overflow);
    // 平均值走自己的累计，不受窗口回退和上游重启影响
    if (this.totals.ingest(status)) this.persist?.(this.totals.toJSON());
    return status;
  }

  /** UI 每次读状态时调用：刷新存活时间，必要时懒启动定时采样。 */
  touch() {
    this.lastAccess = this.now();
    if (!this.timer) this.start();
    return this;
  }

  start() {
    if (this.timer || typeof this.fetchStatus !== 'function') return this;
    this.timer = this.setIntervalFn(() => {
      void this.poll();
    }, this.intervalMs);
    // 别让采样定时器拖住进程退出（node --test / Ctrl-C）
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    void this.poll();
    return this;
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.samples = [];
    this.lastStatus = null;
    return this;
  }

  async poll() {
    if (this.polling || typeof this.fetchStatus !== 'function') return null;
    this.polling = true;
    try {
      const status = await this.fetchStatus();
      if (!status || typeof status !== 'object') return null;
      return this.record(status);
    } catch {
      // 上游抖动：本轮丢弃。旧样本按「过期」规则自然失效，不拿旧数充新数。
      return null;
    } finally {
      this.polling = false;
      if (
        this.timer &&
        this.lastAccess !== null &&
        this.now() - this.lastAccess > this.idleStopMs
      ) {
        this.stop();
      }
    }
  }

  /** 手动重置累计平均值（管理页点「刷新」时调用），返回新的持久化状态。 */
  resetTotals(status = this.lastStatus) {
    this.totals.reset(status);
    return this.totals.toJSON();
  }

  /** 当前展示用的速度快照（并保持采样存活）。 */
  snapshot() {
    this.touch();
    return summarizeSpeed({
      samples: this.samples,
      status: this.lastStatus,
      totals: this.totals.snapshot(),
      now: this.now(),
      windowMs: this.windowMs,
      minSpanMs: this.minSpanMs,
    });
  }
}
