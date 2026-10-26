import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigPatch, buildServeArgv } from '../src/whitelist.js';

describe('validateConfigPatch', () => {
  it('rejects unknown / dangerous keys', () => {
    const r = validateConfigPatch({ model: 'a/b', shell: 'rm -rf /', command: 'evil' });
    assert.equal(r.ok, false);
    assert.match(r.error, /拒绝危险/);
  });

  it('rejects non-localhost host', () => {
    const r = validateConfigPatch({ host: '0.0.0.0' });
    assert.equal(r.ok, false);
    assert.match(r.error, /host/);
  });

  it('rejects shell metacharacters in model', () => {
    const r = validateConfigPatch({ model: 'foo; bar' });
    assert.equal(r.ok, false);
  });

  it('accepts daily flags', () => {
    const r = validateConfigPatch({
      model: '/Users/yuanxj/.lmstudio/models/mlx-community/Qwen3.8-27B-4bit',
      port: 8000,
      host: '127.0.0.1',
      maxMemory: '28G',
      maxContext: '128K',
      offline: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.needsRestart, true);
  });
});

describe('buildServeArgv', () => {
  it('only emits whitelist flags', () => {
    const { args, display } = buildServeArgv({
      model: 'owner/repo:Q4',
      port: 9000,
      host: '127.0.0.1',
      maxMemory: '28G',
      offline: true,
      splashBinary: '/opt/homebrew/bin/splash',
    });
    assert.deepEqual(args.slice(0, 3), ['serve', '--model', 'owner/repo:Q4']);
    assert.ok(args.includes('--port'));
    assert.ok(args.includes('9000'));
    assert.ok(args.includes('--max-memory'));
    assert.ok(args.includes('--offline'));
    assert.ok(!display.includes('rm '));
    assert.ok(!args.some((a) => a.includes(';')));
  });

  it('requires model', () => {
    assert.throws(() => buildServeArgv({ port: 8000 }), /model/);
  });
});
