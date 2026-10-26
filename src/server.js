import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_SPECS, validateConfigPatch, buildServeArgv } from './whitelist.js';
import {
  loadConfig,
  saveConfig,
  configPath,
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
import { probeSplash } from './splash-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ADMIN_HOST = process.env.SPLASH_WEB_HOST || '127.0.0.1';
const bootConfig = loadConfig();
const ADMIN_PORT = resolvePublicPort(bootConfig);

const app = express();

app.use((req, res, next) => {
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

adminApi.get('/models', (_req, res) => {
  res.json(listPreferredModels());
});

adminApi.get('/status', async (_req, res) => {
  const config = loadConfig();
  const ownership = await ownershipStatus(config);
  const probe = ownership.probe;
  const publicPort = resolvePublicPort(config);
  const upstreamPort = resolveUpstreamPort(config);
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
      summary: probe.summary,
    },
    dryRun: dryRunEnabled(),
    previewCommand: previewCommand(config).display,
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
 */
function proxyToUpstream(req, res) {
  const config = loadConfig();
  const upstreamPort = resolveUpstreamPort(config);
  const upstreamHost = (config.host === '0.0.0.0' ? '127.0.0.1' : config.host) || '127.0.0.1';

  if (dryRunEnabled()) {
    res.status(503).type('text/plain; charset=utf-8').send(
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
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
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

  req.pipe(proxyReq);
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
