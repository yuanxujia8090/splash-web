import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySamplingDefaults,
  samplingDefaults,
  samplingEnabled,
  shouldApplySampling,
  describeSampling,
  NATIVE_DEFAULTS,
  SAMPLING_PATHS,
} from '../src/sampling.js';
import { validateConfigPatch } from '../src/whitelist.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const BASE = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  applySamplingDefaults: true,
};

describe('采样配置校验', () => {
  it('接受小数温度与 top_p', () => {
    const r = validateConfigPatch({ temperature: 0.7, topP: 0.9, topK: 40 });
    assert.equal(r.ok, true);
    assert.equal(r.config.temperature, 0.7);
    assert.equal(r.config.topP, 0.9);
    assert.equal(r.config.topK, 40);
  });

  it('温度超出 [0,2] 被拒', () => {
    assert.equal(validateConfigPatch({ temperature: 2.5 }).ok, false);
    assert.equal(validateConfigPatch({ temperature: -0.1 }).ok, false);
  });

  it('top_p 必须 > 0 且 <= 1', () => {
    assert.equal(validateConfigPatch({ topP: 0 }).ok, false);
    assert.equal(validateConfigPatch({ topP: 1.2 }).ok, false);
    assert.equal(validateConfigPatch({ topP: 0.01 }).ok, true);
  });

  it('top_k 允许 -1 / 0 / 正整数，拒绝其它', () => {
    for (const topK of [-1, 0, 20]) {
      assert.equal(validateConfigPatch({ topK }).ok, true, `topK=${topK}`);
    }
    for (const topK of [-2, 1.5]) {
      assert.equal(validateConfigPatch({ topK }).ok, false, `topK=${topK}`);
    }
  });

  it('采样项不进入重启判定', () => {
    const r = validateConfigPatch({ temperature: 0.7 });
    assert.equal(r.ok, true);
    assert.equal(r.needsRestart, false);
  });

  it('未知键仍然被拒', () => {
    assert.equal(validateConfigPatch({ topQ: 1 }).ok, false);
  });
});

describe('默认值', () => {
  it('默认配置与 Splash 原生默认一致（开开关也不改变行为）', () => {
    assert.equal(DEFAULT_CONFIG.temperature, NATIVE_DEFAULTS.temperature);
    assert.equal(DEFAULT_CONFIG.topP, NATIVE_DEFAULTS.top_p);
    assert.equal(DEFAULT_CONFIG.topK, NATIVE_DEFAULTS.top_k);
    assert.equal(DEFAULT_CONFIG.applySamplingDefaults, true);
  });

  it('samplingDefaults 只输出配置里存在的数字', () => {
    assert.deepEqual(samplingDefaults(BASE), { temperature: 0.7, top_p: 0.9, top_k: 40 });
    assert.deepEqual(samplingDefaults({ temperature: '0.7' }), {});
  });
});

describe('applySamplingDefaults', () => {
  it('补齐缺失字段', () => {
    const { body, applied } = applySamplingDefaults({ messages: [] }, BASE);
    assert.deepEqual(applied, { temperature: 0.7, top_p: 0.9, top_k: 40 });
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
  });

  it('不覆盖客户端显式值', () => {
    const { body, applied } = applySamplingDefaults(
      { temperature: 0.2, top_p: 0.5 },
      BASE,
    );
    assert.deepEqual(applied, { top_k: 40 });
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.5);
  });

  it('显式 null 也视为客户端自己的选择', () => {
    const { applied } = applySamplingDefaults({ temperature: null }, BASE);
    assert.equal(Object.hasOwn(applied, 'temperature'), false);
  });

  it('关闭注入时原样返回', () => {
    const input = { messages: [] };
    const { body, applied } = applySamplingDefaults(input, {
      ...BASE,
      applySamplingDefaults: false,
    });
    assert.equal(body, input);
    assert.deepEqual(applied, {});
  });

  it('非对象请求体不动', () => {
    assert.deepEqual(applySamplingDefaults([1, 2, 3], BASE).applied, {});
    assert.deepEqual(applySamplingDefaults(null, BASE).applied, {});
  });
});

describe('shouldApplySampling', () => {
  const post = (path, contentType = 'application/json') => ({
    method: 'POST',
    path,
    headers: { 'content-type': contentType },
  });

  it('只对采样相关 API 路径注入', () => {
    for (const path of SAMPLING_PATHS) {
      assert.equal(shouldApplySampling(post(path)), true, path);
    }
    assert.equal(shouldApplySampling(post('/v1/models')), false);
    assert.equal(shouldApplySampling(post('/admin/api/config')), false);
  });

  it('忽略非 POST 与非 JSON', () => {
    assert.equal(shouldApplySampling({ ...post('/v1/chat/completions'), method: 'GET' }), false);
    assert.equal(
      shouldApplySampling(post('/v1/chat/completions', 'multipart/form-data')),
      false,
    );
    assert.equal(shouldApplySampling(post('/v1/chat/completions', 'application/json; charset=utf-8')), true);
  });
});

describe('describeSampling', () => {
  it('给出启用状态、生效值、原生默认与说明', () => {
    const d = describeSampling(BASE);
    assert.equal(d.enabled, true);
    assert.deepEqual(d.effective, { temperature: 0.7, top_p: 0.9, top_k: 40 });
    assert.deepEqual(d.native, { ...NATIVE_DEFAULTS });
    assert.match(d.note, /不用重启/);
  });

  it('samplingEnabled 视 undefined 为开启', () => {
    assert.equal(samplingEnabled({}), true);
    assert.equal(samplingEnabled({ applySamplingDefaults: false }), false);
  });
});
