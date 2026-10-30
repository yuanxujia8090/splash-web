import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSpeedCounters,
  windowRate,
  summarizeSpeed,
  SpeedSampler,
  SpeedTotals,
  MIN_SPAN_MS,
} from '../src/token-speed.js';

/** 造一个采样点：time 毫秒，decode/prefill 是 Splash 的累计计数。 */
const sample = (time, decode, prefill = 0) => ({ time, counters: { decode, prefill } });

/** 造一个最小可用的 /status。 */
const statusWith = (metrics = {}) => ({
  ready: true,
  metrics: {
    decode_output_tokens: 0,
    prefill_input_tokens: 0,
    ...metrics,
  },
});

describe('readSpeedCounters', () => {
  it('读出 decode / prefill 累计计数与引擎耗时', () => {
    const counters = readSpeedCounters(
      statusWith({
        decode_output_tokens: 1234,
        prefill_input_tokens: 5678,
        decode_wall_ms: 2000,
        prefill_wall_ms: 500,
      }),
    );
    assert.deepEqual(counters, {
      decode: 1234,
      prefill: 5678,
      decodeWallMs: 2000,
      prefillWallMs: 500,
    });
  });

  it('缺字段时是 null（不猜 0）', () => {
    const empty = { decode: null, prefill: null, decodeWallMs: null, prefillWallMs: null };
    assert.deepEqual(readSpeedCounters({ metrics: {} }), empty);
    assert.deepEqual(readSpeedCounters(null), empty);
  });

  it('字符串数字也能用', () => {
    assert.deepEqual(readSpeedCounters({ metrics: { decode_output_tokens: '42' } }), {
      decode: 42,
      prefill: null,
      decodeWallMs: null,
      prefillWallMs: null,
    });
  });
});

describe('windowRate（与 pi-token-speed 同公式）', () => {
  it('1000ms 内新增 200 token = 200 tok/s', () => {
    const samples = [sample(0, 0), sample(1000, 200)];
    assert.equal(windowRate(samples, 'decode', 1000, { windowMs: 1000 }), 200);
  });

  it('时间跨度按 100ms 下限算，突发不虚高', () => {
    const samples = [sample(5000, 0), sample(5000, 5)];
    const rate = windowRate(samples, 'decode', 5000, { windowMs: 1000 });
    assert.equal(rate, (1000 * 5) / MIN_SPAN_MS);
  });

  it('样本不足两个 → null（不编造速度）', () => {
    assert.equal(windowRate([sample(0, 10)], 'decode', 0, { windowMs: 1000 }), null);
    assert.equal(windowRate([], 'decode', 0, { windowMs: 1000 }), null);
  });

  it('采样过期（最后样本早于窗口起点）→ null', () => {
    const samples = [sample(0, 0), sample(1000, 100)];
    assert.equal(windowRate(samples, 'decode', 5000, { windowMs: 1000 }), null);
  });

  it('计数器回绕（Splash 重启后变小）→ null', () => {
    const samples = [sample(0, 1000), sample(1000, 500)];
    assert.equal(windowRate(samples, 'decode', 1000, { windowMs: 1000 }), null);
  });

  it('窗口内没有新增 token → 0（0 是有效速度，不等于没数据）', () => {
    const samples = [sample(0, 100), sample(1000, 100)];
    assert.equal(windowRate(samples, 'decode', 1000, { windowMs: 1000 }), 0);
  });

  it('用窗口前一个样本做基准，覆盖整个窗口', () => {
    // 窗口起点 1000，实际基准取 0 那一笔 → 覆盖 0..1000 全程
    const samples = [sample(0, 0), sample(400, 100), sample(1000, 150)];
    assert.equal(windowRate(samples, 'decode', 1000, { windowMs: 1000 }), 150);
  });
});

describe('summarizeSpeed', () => {
  it('窗口在产出 → 用窗口值（实时）', () => {
    const speed = summarizeSpeed({
      samples: [sample(0, 0), sample(1000, 200)],
      status: statusWith({ decode_tokens_per_second: 50 }),
      now: 1000,
    });
    assert.equal(speed.decodeTokPerSec, 200);
    assert.equal(speed.source, 'window');
    assert.equal(speed.decodeWindowTokPerSec, 200);
    // 平均值单独留着，UI 拿它在实时值旁边做对照
    assert.equal(speed.decodeAverageTokPerSec, 50);
    assert.equal(speed.prefillAverageTokPerSec, null);
  });

  it('窗口没产出且空闲 → 回退累计平均（对齐 endTpsBehavior=average）', () => {
    const speed = summarizeSpeed({
      samples: [sample(0, 100), sample(1000, 100)],
      status: statusWith({ decode_tokens_per_second: 42, prefill_tokens_per_second: 900 }),
      now: 1000,
    });
    assert.equal(speed.decodeTokPerSec, 42);
    assert.equal(speed.prefillTokPerSec, 900);
    assert.equal(speed.source, 'average');
    // 窗口实时值仍是 0：判断「在不在算」用这个，不能被平均点亮
    assert.equal(speed.decodeWindowTokPerSec, 0);
  });

  it('窗口 0 但有活跃请求 → 就是 0，不被历史平均盖住（卡了看得出来）', () => {
    const busyStatus = statusWith({ decode_tokens_per_second: 42 });
    busyStatus.scheduler = { prefilling: 0, decode_batches: 1 };
    const speed = summarizeSpeed({
      samples: [sample(0, 100), sample(1000, 100)],
      status: busyStatus,
      now: 1000,
    });
    assert.equal(speed.decodeTokPerSec, 0);
    assert.equal(speed.source, 'window');
  });

  it('decode 实时、prefill 只有平均时，两个来源分开报', () => {
    const speed = summarizeSpeed({
      samples: [sample(0, 0, 0), sample(1000, 200, 0)],
      status: statusWith({ decode_tokens_per_second: 50, prefill_tokens_per_second: 900 }),
      now: 1000,
    });
    assert.equal(speed.decodeSource, 'window');
    assert.equal(speed.prefillSource, 'average');
    assert.equal(speed.decodeTokPerSec, 200);
    assert.equal(speed.prefillTokPerSec, 900);
  });

  it('采样停了两个窗口 → 不用旧窗口值', () => {
    const speed = summarizeSpeed({
      samples: [sample(0, 0), sample(1000, 200)],
      status: statusWith({ decode_tokens_per_second: 77 }),
      now: 4000,
    });
    assert.equal(speed.decodeTokPerSec, 77);
    assert.equal(speed.source, 'average');
  });

  it('完全没有数据 → null（UI 显示 —）', () => {
    const speed = summarizeSpeed({ samples: [], status: null, now: 1000 });
    assert.equal(speed.decodeTokPerSec, null);
    assert.equal(speed.prefillTokPerSec, null);
    assert.equal(speed.source, 'none');
  });
});

describe('SpeedTotals（累计平均，不清零）', () => {
  const withWall = (decode, decodeWallMs, prefill = 0, prefillWallMs = 0) =>
    statusWith({
      decode_output_tokens: decode,
      decode_wall_ms: decodeWallMs,
      prefill_input_tokens: prefill,
      prefill_wall_ms: prefillWallMs,
    });

  it('首次采样直接采信上游历史累计（不从 0 重算）', () => {
    const totals = new SpeedTotals();
    totals.ingest(withWall(5000, 10_000));
    assert.equal(totals.snapshot().decodeTokPerSec, 500);
    assert.equal(totals.snapshot().decodeTokens, 5000);
  });

  it('后续采样只累加增量', () => {
    const totals = new SpeedTotals();
    totals.ingest(withWall(100, 1000));
    totals.ingest(withWall(300, 3000));
    const snap = totals.snapshot();
    assert.equal(snap.decodeTokens, 300);
    assert.equal(snap.decodeTokPerSec, 100); // 300 token / 3000ms
  });

  it('上游重启计数归零：跳过该轮，历史总量不清零', () => {
    const totals = new SpeedTotals();
    totals.ingest(withWall(1000, 5000));
    totals.ingest(withWall(1200, 6000)); // +200 / +1000ms
    totals.ingest(withWall(0, 0)); // Splash 重启，负数增量被丢弃
    totals.ingest(withWall(50, 500)); // 重启后 +50 / +500ms
    const snap = totals.snapshot();
    assert.equal(snap.decodeTokens, 1250);
    assert.equal(snap.decodeWallMs, 6500);
  });

  it('reset 后归零，且不会把上游历史重新采信回来', () => {
    const totals = new SpeedTotals();
    totals.ingest(withWall(5000, 10_000)); // 历史累计 500 tok/s
    totals.reset(withWall(5000, 10_000)); // 在当前读数处重置
    assert.equal(totals.snapshot().decodeTokPerSec, null);

    totals.ingest(withWall(5200, 10_400)); // 只算 +200 / +400ms
    const snap = totals.snapshot();
    assert.equal(snap.decodeTokens, 200);
    assert.equal(snap.decodeWallMs, 400);
    assert.equal(snap.decodeTokPerSec, 500);
  });

  it('prefill 与 decode 分开累计', () => {
    const totals = new SpeedTotals();
    totals.ingest(withWall(0, 0, 4000, 2000));
    assert.equal(totals.snapshot().prefillTokPerSec, 2000);
    assert.equal(totals.snapshot().decodeTokPerSec, null);
  });

  it('持久化后恢复，继续累加而不重头', () => {
    const first = new SpeedTotals();
    first.ingest(withWall(1000, 5000));
    const restored = new SpeedTotals(JSON.parse(JSON.stringify(first.toJSON())));
    restored.ingest(withWall(1100, 5500)); // +100 / +500ms
    const snap = restored.snapshot();
    assert.equal(snap.decodeTokens, 1100);
    assert.equal(snap.decodeWallMs, 5500);
  });

  it('summarizeSpeed 优先用自累计平均，而不是 Splash 自报值', () => {
    const speed = summarizeSpeed({
      samples: [],
      status: statusWith({ decode_tokens_per_second: 999 }),
      totals: { decodeTokPerSec: 321 },
      now: 1000,
    });
    assert.equal(speed.decodeAverageTokPerSec, 321);
  });
});

describe('SpeedSampler', () => {
  /** 可控时钟 + 空定时器，避免测试里跑真 interval。 */
  function makeSampler(statuses) {
    let clock = 0;
    let next = 0;
    const intervalFns = [];
    const sampler = new SpeedSampler({
      fetchStatus: async () => statuses[Math.min(next++, statuses.length - 1)],
      now: () => clock,
      setIntervalFn: (fn) => {
        intervalFns.push(fn);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
      idleStopMs: 60_000,
    });
    return {
      sampler,
      tick: (ms) => {
        clock += ms;
      },
      get clock() {
        return clock;
      },
    };
  }

  it('poll 后样本进入窗口，snapshot 给出速度', async () => {
    const { sampler, tick } = makeSampler([
      statusWith({ decode_output_tokens: 0 }),
      statusWith({ decode_output_tokens: 100 }),
    ]);

    await sampler.poll();
    tick(1000);
    await sampler.poll();

    const speed = sampler.snapshot();
    assert.equal(speed.decodeTokPerSec, 100);
    assert.equal(speed.source, 'window');
    assert.equal(speed.samples, 2);
  });

  it('上游返回 null（不可达）时不记样本', async () => {
    const sampler = new SpeedSampler({
      fetchStatus: async () => null,
      now: () => 0,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
    await sampler.poll();
    assert.equal(sampler.samples.length, 0);
  });

  it('fetch 抛错不崩，样本保持', async () => {
    const sampler = new SpeedSampler({
      fetchStatus: async () => {
        throw new Error('boom');
      },
      now: () => 0,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
    assert.equal(await sampler.poll(), null);
    assert.equal(sampler.samples.length, 0);
  });

  it('样本数不超过上限（长跑不涨内存）', async () => {
    let n = 0;
    const sampler = new SpeedSampler({
      fetchStatus: async () => statusWith({ decode_output_tokens: n++ }),
      now: () => 0,
      maxSamples: 3,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
    for (let i = 0; i < 6; i++) await sampler.poll();
    assert.equal(sampler.samples.length, 3);
  });

  it('空闲超时后停止采样并清空', async () => {
    let clock = 0;
    const sampler = new SpeedSampler({
      fetchStatus: async () => statusWith({ decode_output_tokens: 1 }),
      now: () => clock,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      idleStopMs: 10,
    });
    sampler.touch();
    assert.equal(sampler.running, true);
    await sampler.poll();
    clock = 100;
    await sampler.poll();
    assert.equal(sampler.running, false);
    assert.equal(sampler.samples.length, 0);
  });

  it('resetTotals 清零平均值，并把当前读数当新基线', () => {
    const sampler = new SpeedSampler({
      fetchStatus: async () => null,
      now: () => 0,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
    sampler.record(
      statusWith({ decode_output_tokens: 800, decode_wall_ms: 4000 }),
    );
    assert.equal(sampler.snapshot().decodeAverageTokPerSec, 200);

    sampler.resetTotals();
    assert.equal(sampler.snapshot().decodeAverageTokPerSec, null);

    // 只累计重置之后的增量：+100 token / +400ms = 250 tok/s
    sampler.record(
      statusWith({ decode_output_tokens: 900, decode_wall_ms: 4400 }),
    );
    assert.equal(sampler.snapshot().decodeAverageTokPerSec, 250);
  });

  it('touch 会懒启动定时采样', () => {
    const sampler = new SpeedSampler({
      fetchStatus: async () => statusWith(),
      now: () => 0,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
    assert.equal(sampler.running, false);
    sampler.touch();
    assert.equal(sampler.running, true);
  });
});
