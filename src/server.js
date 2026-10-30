import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_SPECS, validateConfigPatch, buildServeArgv } from './whitelist.js';
import {
  loadConfig,
  saveConfig,
  configPath,
  runtimeDir,
  DEFAULT_CONFIG,
  resolvePublicPort,
  resolveUpstreamPort,
} from './config.js';
import { listPreferredModels, PREFERRED_MODEL_ROOTS } from './models.js';
import {
  ownershipStatus,
  previewCommand,
  startManaged,
  stopManaged,
  restartManaged,
  shutdownAll,
  dryRunEnabled,
} from './process-manager.js';
import { fetchStatus, summarizeStatus } from './splash-client.js';
import { SpeedSampler } from './token-speed.js';
import {
  applySamplingDefaults,
  describeSampling,
  shouldApplySampling,
  SAMPLING_MAX_BODY_BYTES,
} from './sampling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ADMIN_HOST = process.env.SPLASH_WEB_HOST || '127.0.0.1';
const bootConfig = loadConfig();
const ADMIN_PORT = resolvePublicPort(bootConfig);

const app = express();

/**
 * 累计平均速度的落盘点：重启 splash-web / Splash 都不清零。
 * 默认在 ~/.config/splash-web/ 下，跟 config.json 同目录。
 */
const SPEED_STATS_PATH = path.join(runtimeDir(), 'speed-stats.json');
const SPEED_STATS_WRITE_INTERVAL_MS = 30_000;
let lastSpeedStatsWrite = 0;

function loadSpeedStats() {
  try {
    return JSON.parse(fs.readFileSync(SPEED_STATS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 节流写盘：平均速度不需要每秒落盘，30s 一次足够，丢的也只是几十秒增量。
 * 写失败不影响读数，下一轮再试。
 */
function saveSpeedStats(state) {
  const now = Date.now();
  if (now - lastSpeedStatsWrite < SPEED_STATS_WRITE_INTERVAL_MS) return;
  lastSpeedStatsWrite = now;
  try {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    const tmp = `${SPEED_STATS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, SPEED_STATS_PATH);
  } catch {
    // 写盘失败：读数照常，下一轮重试
  }
}

/**
 * 速度采样器：每秒读一次上游 /status 的累计计数，用时间滑动窗口算 tok/s。
 * 口径对齐 https://github.com/gsanhueza/pi-token-speed（详见 src/token-speed.js）。
 * 懒启动：有管理页来读状态才跑；60s 没人读就自己停。
 */
const speedSampler = new SpeedSampler({
  initialTotals: loadSpeedStats(),
  persist: saveSpeedStats,
  fetchStatus: async () => {
    const config = loadConfig();
    return fetchStatus({ host: config.host, port: resolveUpstreamPort(config) });
  },
});

app.use((_req, res, next) => {
  res.setHeader('X-Splash-Web', '1');
  next();
});

const adminApi = express.Router();
adminApi.use(express.json({ limit: '64kb' }));

adminApi.get('/meta', (_req, res) => {
  const config = loadConfig();
  const publicPort = resolvePublicPort(config);
  const upstreamPort = resolveUpstreamPort(config);
  res.json({
    name: 'splash-web',
    version: '0.1.0',
    admin: {
      host: ADMIN_HOST,
      port: publicPort,
      path: '/admin',
      url: `http://${ADMIN_HOST}:${publicPort}/admin`,
    },
    upstream: {
      host: config.host || '127.0.0.1',
      port: upstreamPort,
    },
    configPath: configPath(),
    preferredModelRoots: PREFERRED_MODEL_ROOTS,
    sampling: describeSampling(config),
    dryRun: dryRunEnabled(),
    license: 'Apache-2.0',
    principles: [
      'localhost only',
      'whitelist CLI flags only — no general shell',
      'reuse ~/.lmstudio/models and ~/.omlx/models — no download',
      'manage only processes spawned by this admin',
      'one public port: admin at /admin, Splash via reverse proxy',
    ],
  });
});

adminApi.get('/flags', (_req, res) => {
  res.json({ flags: FLAG_SPECS, defaults: DEFAULT_CONFIG });
});

adminApi.get('/config', (_req, res) => {
  const config = loadConfig();
  let command = null;
  try {
    command = buildServeArgv(config).display;
  } catch {
    command = null;
  }
  res.json({
    config,
    path: configPath(),
    publicPort: resolvePublicPort(config),
    upstreamPort: resolveUpstreamPort(config),
    needsRestartHint: '修改配置后需重启 Splash 才生效',
    previewCommand: command,
  });
});

adminApi.put('/config', (req, res) => {
  const patchResult = validateConfigPatch(req.body || {});
  if (!patchResult.ok) {
    return res.status(400).json(patchResult);
  }
  const saved = saveConfig(req.body || {});
  if (!saved.ok) {
    return res.status(400).json(saved);
  }
  let preview = null;
  try {
    preview = buildServeArgv(saved.config).display;
  } catch {
    preview = null;
  }
  res.json({
    ...saved,
    previewCommand: preview,
    publicPort: resolvePublicPort(saved.config),
    upstreamPort: resolveUpstreamPort(saved.config),
  });
});

adminApi.get('/sampling', (_req, res) => {
  res.json(describeSampling(loadConfig()));
});

adminApi.get('/models', (_req, res) => {
  res.json(listPreferredModels());
});

adminApi.get('/status', async (_req, res) => {
  const config = loadConfig();
  const ownership = await ownershipStatus(config);
  const probe = ownership.probe;
  // 这次 probe 已经拿到原始 status，顺手记一笔样本（比等下一轮采样更快出数）
  if (probe.status) speedSampler.record(probe.status);
  const speed = speedSampler.snapshot();
  const summary = summarizeStatus(probe.status, speed);
  const publicPort = resolvePublicPort(config);
  const upstreamPort = resolveUpstreamPort(config);
  // 没配 model 时 buildLaunchPlan 会抛错（刚装好、配置还空）；这不能让整个 /status 挂掉
  let preview = null;
  try {
    preview = previewCommand(config).display;
  } catch {
    preview = null;
  }
  res.json({
    configTarget: {
      host: config.host,
      port: publicPort,
      upstreamPort,
      model: config.model,
    },
    ownership: {
      kind: ownership.kind,
      managedPid: ownership.managedPid,
      canRestart: ownership.canRestart,
      message: ownership.message,
      upstreamPort,
    },
    probe: {
      baseUrl: probe.baseUrl,
      reachable: probe.reachable,
      ready: probe.ready,
      error: probe.error,
      summary,
      speed,
    },
    dryRun: dryRunEnabled(),
    previewCommand: preview,
  });
});

adminApi.get('/preview-command', (_req, res) => {
  const config = loadConfig();
  try {
    res.json(previewCommand(config));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * 手动重置累计平均值：管理页点「刷新」时调用。
 * 只影响平均口径，不动滑动窗口，也不动 Splash 自己的计数。
 */
adminApi.post('/speed/reset', async (_req, res) => {
  // 先拿一份当前读数当新基线，否则重置会退回到上一次采样（最多 1 秒前）
  const config = loadConfig();
  const fresh = await fetchStatus({
    host: config.host,
    port: resolveUpstreamPort(config),
  });
  const state = speedSampler.resetTotals(fresh);
  // 强制落盘，否则重启后又把旧的平均值读回来
  lastSpeedStatsWrite = 0;
  saveSpeedStats(state);
  res.json({ ok: true, resetAt: state.updatedAt });
});

adminApi.post('/start', async (_req, res) => {
  const result = await startManaged(loadConfig());
  res.status(result.ok ? 200 : 400).json(result);
});

adminApi.post('/stop', async (_req, res) => {
  const ownership = await ownershipStatus(loadConfig());
  if (ownership.kind === 'external') {
    return res.status(400).json({
      ok: false,
      error: ownership.message,
    });
  }
  const result = await stopManaged();
  res.status(result.ok ? 200 : 400).json(result);
});

adminApi.post('/restart', async (_req, res) => {
  const result = await restartManaged(loadConfig());
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * Full shutdown: stop managed Splash, then exit this node process (release :8000).
 * Responds first so the UI can show success before the connection drops.
 */
adminApi.post('/shutdown', async (_req, res) => {
  const result = await shutdownAll();
  if (!result.ok) {
    res.status(400).json({ ok: false, ...result });
    return;
  }
  res.json({ ok: true, exiting: true, ...result });
  // 退出前把累计平均值强制落盘（不守 30s 节流，否则丢最后一段）
  lastSpeedStatsWrite = 0;
  saveSpeedStats(speedSampler.totals.toJSON());
  setTimeout(() => {
    try {
      server.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    // If close hangs, still exit
    setTimeout(() => process.exit(0), 1500);
  }, 200);
});

app.use('/admin/api', adminApi);

function sendAdminIndex(_req, res) {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
}

// Assets are absolute /admin/... so both /admin and /admin/ are fine (no redirect loop;
// Express non-strict routing would make /admin → /admin/ → /admin/ infinite).
app.get(['/admin', '/admin/'], sendAdminIndex);

app.use('/admin', express.static(PUBLIC_DIR, { index: false, redirect: false }));

// SPA fallback under /admin (API already handled above)
app.use('/admin', sendAdminIndex);

/**
 * Reverse-proxy non-admin traffic to managed Splash on upstreamPort.
 * Uses Node http.request so streaming / long responses can pass through.
 * JSON 请求体会先缓冲：只在客户端没写采样字段时补上本端默认值。
 */
function proxyToUpstream(req, res) {
  const config = loadConfig();
  const upstreamPort = resolveUpstreamPort(config);
  const upstreamHost = (config.host === '0.0.0.0' ? '127.0.0.1' : config.host) || '127.0.0.1';

  if (dryRunEnabled()) {
    res.status(403).type('text/plain; charset=utf-8').send(
      [
        'splash-web DRY_RUN：管理页可用（/admin），未拉起 Splash，故无法反代。',
        `上游约定端口：${upstreamPort}`,
        '去掉 SPLASH_WEB_DRY_RUN 后在 /admin 点「启动」即可接通。',
      ].join('\n'),
    );
    return;
  }

  const headers = { ...req.headers };
  headers.host = `${upstreamHost}:${upstreamPort}`;

  let injected = '';

  const proxyReq = http.request(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      path: req.originalUrl || req.url,
      method: req.method,
      headers,
      timeout: 0,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        ...proxyRes.headers,
        ...(injected ? { 'x-splash-web-sampling': injected } : {}),
      });
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
  });

  proxyReq.on('error', (err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(503).json({
      ok: false,
      error: `Splash 上游未就绪（${upstreamHost}:${upstreamPort}）：${err.message}`,
      hint: '请先打开 /admin 启动或重启本端 Splash。',
      upstreamPort,
    });
  });

  const declared = Number(req.headers['content-length']);
  const buffered = shouldApplySampling(req)
    && !(Number.isFinite(declared) && declared > SAMPLING_MAX_BODY_BYTES);

  if (!buffered) {
    req.pipe(proxyReq);
    return;
  }

  // 缓冲请求体 → 补缺省 → 重写 content-length。超过上限则回退为原样转发。
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let overflow = false;

  req.on('data', (chunk) => {
    if (overflow) {
      proxyReq.write(chunk);
      return;
    }
    size += chunk.length;
    chunks.push(chunk);
    if (size > SAMPLING_MAX_BODY_BYTES) {
      overflow = true;
      for (const part of chunks) proxyReq.write(part);
      chunks.length = 0;
    }
  });

  req.on('end', () => {
    if (overflow) {
      proxyReq.end();
      return;
    }

    let payload = Buffer.concat(chunks);
    try {
      const body = JSON.parse(payload.toString('utf8'));
      const result = applySamplingDefaults(body, config);
      if (Object.keys(result.applied).length) {
        payload = Buffer.from(JSON.stringify(result.body), 'utf8');
        injected = Object.entries(result.applied)
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
      }
    } catch {
      // 非 JSON / 解析失败：原样转发，不猜
    }

    proxyReq.removeHeader('transfer-encoding');
    proxyReq.setHeader('content-length', String(payload.length));
    proxyReq.end(payload);
  });

  req.on('aborted', () => proxyReq.destroy());
}

app.use((req, res) => {
  proxyToUpstream(req, res);
});

const server = app.listen(ADMIN_PORT, ADMIN_HOST, () => {
  const upstreamPort = resolveUpstreamPort(bootConfig);
  console.log(`[splash-web] public  http://${ADMIN_HOST}:${ADMIN_PORT}`);
  console.log(`[splash-web] admin   http://${ADMIN_HOST}:${ADMIN_PORT}/admin`);
  console.log(`[splash-web] upstream Splash :${upstreamPort} (spawn --port)`);
  console.log(`[splash-web] config  ${configPath()}`);
  console.log(`[splash-web] dryRun=${dryRunEnabled()}`);
  console.log(`[splash-web] model roots: ${PREFERRED_MODEL_ROOTS.join(', ')}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[splash-web] 对外端口 ${ADMIN_PORT} 已被占用（常见原因：你之前在终端手开的 Splash 占了 8000）。`,
    );
    console.error(
      `[splash-web] 请先停掉占用该端口的进程，再运行 npm start：由 splash-web 统一占 ${ADMIN_PORT}，管理页在 /admin，Splash 反代到上游端口。`,
    );
    console.error(
      `[splash-web] 不要回退到 8787。临时换端口可：SPLASH_WEB_PORT=18080 npm start（文档默认仍是 8000）。`,
    );
  } else {
    console.error('[splash-web]', err);
  }
  process.exit(1);
});
