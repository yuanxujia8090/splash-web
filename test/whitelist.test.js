import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigPatch, buildServeArgv } from '../src/whitelist.js';
import { DEFAULT_CONFIG, resolvePublicPort, resolveUpstreamPort } from '../src/config.js';

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
      upstreamPort: 18000,
      host: '127.0.0.1',
      maxMemory: '28G',
      maxContext: '128K',
      offline: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.needsRestart, true);
  });

  it('accepts upstreamPort', () => {
    const r = validateConfigPatch({ upstreamPort: 18000 });
    assert.equal(r.ok, true);
    assert.equal(r.config.upstreamPort, 18000);
  });
});

describe('buildServeArgv', () => {
  it('only emits whitelist flags and uses upstreamPort for --port', () => {
    const { args, display } = buildServeArgv({
      model: 'owner/repo:Q4',
      port: 8000,
      upstreamPort: 9000,
      host: '127.0.0.1',
      maxMemory: '28G',
      offline: true,
      splashBinary: '/opt/homebrew/bin/splash',
    });
    assert.deepEqual(args.slice(0, 3), ['serve', '--model', 'owner/repo:Q4']);
    assert.ok(args.includes('--port'));
    const portIdx = args.indexOf('--port');
    assert.equal(args[portIdx + 1], '9000');
    assert.ok(!args.includes('8000'), 'public port must not be Splash --port');
    assert.ok(args.includes('--max-memory'));
    assert.ok(args.includes('--offline'));
    assert.ok(!display.includes('rm '));
    assert.ok(!args.some((a) => a.includes(';')));
  });

  it('defaults upstream --port to 18000 when omitted', () => {
    const { args } = buildServeArgv({
      model: 'owner/repo:Q4',
      port: 8000,
      host: '127.0.0.1',
      splashBinary: '/opt/homebrew/bin/splash',
    });
    const portIdx = args.indexOf('--port');
    assert.equal(args[portIdx + 1], '18000');
  });

  it('requires model', () => {
    assert.throws(() => buildServeArgv({ port: 8000 }), /model/);
  });
});

describe('resolve ports', () => {
  it('defaults public 8000 and upstream 18000', () => {
    const prevPort = process.env.SPLASH_WEB_PORT;
    const prevUp = process.env.SPLASH_WEB_UPSTREAM_PORT;
    delete process.env.SPLASH_WEB_PORT;
    delete process.env.SPLASH_WEB_UPSTREAM_PORT;
    try {
      assert.equal(resolvePublicPort({ ...DEFAULT_CONFIG }), 8000);
      assert.equal(resolveUpstreamPort({ ...DEFAULT_CONFIG }), 18000);
      assert.equal(resolvePublicPort({ port: 8010 }), 8010);
      assert.equal(resolveUpstreamPort({ upstreamPort: 19000 }), 19000);
    } finally {
      if (prevPort === undefined) delete process.env.SPLASH_WEB_PORT;
      else process.env.SPLASH_WEB_PORT = prevPort;
      if (prevUp === undefined) delete process.env.SPLASH_WEB_UPSTREAM_PORT;
      else process.env.SPLASH_WEB_UPSTREAM_PORT = prevUp;
    }
  });

  it('env overrides config', () => {
    const prevPort = process.env.SPLASH_WEB_PORT;
    const prevUp = process.env.SPLASH_WEB_UPSTREAM_PORT;
    process.env.SPLASH_WEB_PORT = '18080';
    process.env.SPLASH_WEB_UPSTREAM_PORT = '18001';
    try {
      assert.equal(resolvePublicPort({ port: 8000 }), 18080);
      assert.equal(resolveUpstreamPort({ upstreamPort: 18000 }), 18001);
    } finally {
      if (prevPort === undefined) delete process.env.SPLASH_WEB_PORT;
      else process.env.SPLASH_WEB_PORT = prevPort;
      if (prevUp === undefined) delete process.env.SPLASH_WEB_UPSTREAM_PORT;
      else process.env.SPLASH_WEB_UPSTREAM_PORT = prevUp;
    }
  });
});
