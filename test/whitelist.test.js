import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfigPatch,
  buildServeArgv,
  buildLaunchPlan,
  isLocalModelPath,
  deriveHfIdFromLocalPath,
} from '../src/whitelist.js';
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
      useDflash: true,
      draftModel: '/Users/yuanxj/.omlx/models/z-lab/Qwen3.8-27B-DFlash2',
    });
    assert.equal(r.ok, true);
    assert.equal(r.needsRestart, true);
  });

  it('accepts upstreamPort', () => {
    const r = validateConfigPatch({ upstreamPort: 18000 });
    assert.equal(r.ok, true);
    assert.equal(r.config.upstreamPort, 18000);
  });

  it('accepts useDflash boolean', () => {
    const r = validateConfigPatch({ useDflash: false });
    assert.equal(r.ok, true);
    assert.equal(r.config.useDflash, false);
  });
});

describe('isLocalModelPath / deriveHfId', () => {
  it('detects absolute and home paths', () => {
    assert.equal(isLocalModelPath('/Users/yuanxj/.lmstudio/models/a/b'), true);
    assert.equal(isLocalModelPath('~/models/a/b'), true);
    assert.equal(isLocalModelPath('mlx-community/Qwen3.8-27B-4bit'), false);
    assert.equal(isLocalModelPath('owner/repo:Q4'), false);
  });

  it('derives owner/repo from models/... path', () => {
    assert.equal(
      deriveHfIdFromLocalPath('/Users/yuanxj/.lmstudio/models/mlx-community/Qwen3.8-27B-4bit'),
      'mlx-community/Qwen3.8-27B-4bit',
    );
  });
});

describe('buildServeArgv / buildLaunchPlan', () => {
  it('HF id emits splash serve with whitelist flags and upstreamPort', () => {
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
    // public Origin uses config.port (8000), not upstream 9000
    const aoIdx = args.indexOf('--allowed-origin');
    assert.ok(aoIdx >= 0, 'HF plan must pass --allowed-origin');
    assert.ok(args.includes('http://127.0.0.1:8000'));
    assert.ok(args.includes('http://localhost:8000'));
    assert.equal(args.filter((a) => a === '--allowed-origin').length, 2);
  });

  it('HF id with useDflash + draftModel adds --draft-model', () => {
    const plan = buildLaunchPlan({
      model: 'mlx-community/Qwen3.8-27B-4bit',
      upstreamPort: 18000,
      host: '127.0.0.1',
      useDflash: true,
      draftModel: '/Users/yuanxj/.omlx/models/z-lab/Qwen3.8-27B-DFlash2',
      splashBinary: '/opt/homebrew/bin/splash',
    });
    assert.equal(plan.mode, 'serve');
    const idx = plan.args.indexOf('--draft-model');
    assert.ok(idx >= 0);
    assert.equal(plan.args[idx + 1], '/Users/yuanxj/.omlx/models/z-lab/Qwen3.8-27B-DFlash2');
  });

  it('HF id with useDflash false does not add --draft-model', () => {
    const plan = buildLaunchPlan({
      model: 'mlx-community/Qwen3.8-27B-4bit',
      upstreamPort: 18000,
      host: '127.0.0.1',
      useDflash: false,
      draftModel: '/Users/yuanxj/.omlx/models/z-lab/Qwen3.8-27B-DFlash2',
      splashBinary: '/opt/homebrew/bin/splash',
    });
    assert.equal(plan.mode, 'serve');
    assert.ok(!plan.args.includes('--draft-model'));
  });

  it('local path plans server.server with derived HF id (no splash serve)', () => {
    const local = '/Users/yuanxj/.lmstudio/models/mlx-community/Qwen3.8-27B-4bit';
    const plan = buildLaunchPlan(
      {
        model: local,
        upstreamPort: 18000,
        host: '127.0.0.1',
        queueSize: 32,
        useDflash: true,
        draftModel: '/Users/yuanxj/.omlx/models/z-lab/Qwen3.8-27B-DFlash2',
        splashBinary: '/opt/homebrew/bin/splash',
      },
      { preparedDir: '/tmp/prepared-fake', prepareLocal: false },
    );
    assert.equal(plan.mode, 'local');
    assert.equal(plan.modelId, 'mlx-community/Qwen3.8-27B-4bit');
    assert.ok(plan.args.includes('-m'));
    assert.ok(plan.args.includes('server.server'));
    assert.ok(plan.args.includes('/tmp/prepared-fake'));
    assert.ok(plan.args.includes('--model'));
    assert.ok(plan.args.includes('mlx-community/Qwen3.8-27B-4bit'));
    assert.ok(plan.args.includes('--binary'));
    assert.ok(!plan.args.includes('serve'));
    assert.ok(!plan.args.includes('--draft-model'), 'draft is for prepare, not server.server');
    assert.equal(plan.draft, '/Users/yuanxj/.omlx/models/z-lab/Qwen3.8-27B-DFlash2');
    assert.equal(plan.env.PYTHONPATH, plan.libexec);
    const portIdx = plan.args.indexOf('--port');
    assert.equal(plan.args[portIdx + 1], '18000');
    // local fixture omits port → default publicPort 8000
    assert.ok(plan.args.includes('--allowed-origin'), 'local plan must pass --allowed-origin');
    assert.ok(plan.args.includes('http://127.0.0.1:8000'));
    assert.ok(plan.args.includes('http://localhost:8000'));
    assert.equal(plan.args.filter((a) => a === '--allowed-origin').length, 2);
  });

  it('HF and local plans append allowed-origin for public port', () => {
    const hf = buildLaunchPlan({
      model: 'owner/repo:Q4',
      port: 8010,
      upstreamPort: 18000,
      host: '127.0.0.1',
      splashBinary: '/opt/homebrew/bin/splash',
    });
    assert.equal(hf.mode, 'serve');
    assert.ok(hf.args.includes('http://127.0.0.1:8010'));
    assert.ok(hf.args.includes('http://localhost:8010'));
    assert.ok(!hf.args.includes('http://127.0.0.1:18000'), 'must not use upstream as Origin');
    assert.ok(!hf.args.includes('*'));

    const local = '/Users/yuanxj/.lmstudio/models/mlx-community/Qwen3.8-27B-4bit';
    const loc = buildLaunchPlan(
      {
        model: local,
        port: 8000,
        upstreamPort: 18000,
        host: '127.0.0.1',
        splashBinary: '/opt/homebrew/bin/splash',
      },
      { preparedDir: '/tmp/prepared-fake', prepareLocal: false },
    );
    assert.equal(loc.mode, 'local');
    assert.ok(loc.args.includes('http://127.0.0.1:8000'));
    assert.ok(loc.args.includes('http://localhost:8000'));
    assert.equal(loc.args.filter((a) => a === '--allowed-origin').length, 2);
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
