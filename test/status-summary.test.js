import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStatus } from '../src/splash-client.js';

/** 一个「Ready、无活跃请求、但有历史累计速度」的最小 /status。 */
const idleStatus = () => ({
  ready: true,
  metrics: {
    decode_tokens_per_second: 50,
    prefill_tokens_per_second: 900,
  },
  scheduler: { prefilling: 0, decode_batches: 0, queued: 0 },
  http: { requests: { active: 0, capacity: 8 } },
  instance: { model: 'test-model' },
});

describe('summarizeStatus 速度注入', () => {
  it('给了滑动窗口速度就用它', () => {
    const s = summarizeStatus(idleStatus(), {
      decodeTokPerSec: 123,
      prefillTokPerSec: 456,
      decodeWindowTokPerSec: 123,
      prefillWindowTokPerSec: 456,
      source: 'window',
    });
    assert.equal(s.decodeTokPerSec, 123);
    assert.equal(s.prefillTokPerSec, 456);
    assert.equal(s.speedSource, 'window');
  });

  it('没给 speed 时退回 Splash 字段（当前批优先）', () => {
    const status = idleStatus();
    status.metrics.current_decode_batch = { tokens_per_second: 88 };
    const s = summarizeStatus(status);
    assert.equal(s.decodeTokPerSec, 88);
    assert.equal(s.speedSource, 'splash');
  });

  it('speed 全 null 时退回 Splash 字段', () => {
    const s = summarizeStatus(idleStatus(), {
      decodeTokPerSec: null,
      prefillTokPerSec: null,
      source: 'none',
    });
    assert.equal(s.decodeTokPerSec, 50);
    assert.equal(s.prefillTokPerSec, 900);
  });

  it('窗口为空但回退到平均时，不把状态点亮成「在算」', () => {
    const s = summarizeStatus(idleStatus(), {
      // 平均有值（机器历史上跑过），窗口 0（此刻没产出）
      decodeTokPerSec: 50,
      prefillTokPerSec: 900,
      decodeWindowTokPerSec: 0,
      prefillWindowTokPerSec: 0,
      source: 'average',
    });
    assert.equal(s.decodeTokPerSec, 50);
    assert.equal(s.verdict, 'idle');
  });

  it('窗口有产出时状态为「在算」', () => {
    const s = summarizeStatus(idleStatus(), {
      decodeTokPerSec: 120,
      decodeWindowTokPerSec: 120,
      source: 'window',
    });
    assert.equal(s.verdict, 'computing');
  });

  it('连不上上游时返回离线默认值', () => {
    const s = summarizeStatus(null, { decodeTokPerSec: 99, source: 'window' });
    assert.equal(s.verdict, 'offline');
    assert.equal(s.decodeTokPerSec, null);
    assert.equal(s.speedSource, 'window');
  });
});
