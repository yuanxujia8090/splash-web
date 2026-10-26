/**
 * Manage Splash processes spawned by this admin only.
 * Never shell:true. Never kill unmanaged PIDs without explicit policy.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildServeArgv } from './whitelist.js';
import { ensureDirs, loadConfig, managedMetaPath, pidPath, resolveUpstreamPort } from './config.js';
import { probeSplash, checkPortConflict, splashBaseUrl } from './splash-client.js';

function dryRunEnabled() {
  return process.env.SPLASH_WEB_DRY_RUN === '1' || process.env.SPLASH_WEB_DRY_RUN === 'true';
}

function readPidFile() {
  try {
    const raw = fs.readFileSync(pidPath(), 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  ensureDirs();
  fs.writeFileSync(pidPath(), String(pid) + '\n', 'utf8');
}

function clearPid() {
  try {
    fs.unlinkSync(pidPath());
  } catch {
    /* ignore */
  }
}

function readManagedMeta() {
  try {
    return JSON.parse(fs.readFileSync(managedMetaPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeManagedMeta(meta) {
  ensureDirs();
  fs.writeFileSync(managedMetaPath(), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

function clearManagedMeta() {
  try {
    fs.unlinkSync(managedMetaPath());
  } catch {
    /* ignore */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ownership of whatever is listening on the managed Splash upstream port.
 * Never probe the public admin port (that is splash-web itself).
 */
export async function ownershipStatus(config = loadConfig()) {
  const managedPid = readPidFile();
  const meta = readManagedMeta();
  const managedAlive = managedPid ? pidAlive(managedPid) : false;
  if (managedPid && !managedAlive) {
    clearPid();
    clearManagedMeta();
  }

  const upstreamPort = resolveUpstreamPort(config);
  const probe = await probeSplash({ host: config.host, port: upstreamPort });
  const aliveManaged = managedPid && pidAlive(managedPid);

  if (aliveManaged) {
    return {
      kind: 'managed',
      managedPid,
      meta,
      probe,
      upstreamPort,
      canRestart: true,
      message: `由本管理端拉起的 Splash（PID ${managedPid}，上游 :${upstreamPort}）`,
    };
  }

  if (probe.reachable) {
    return {
      kind: 'external',
      managedPid: null,
      meta: null,
      probe,
      upstreamPort,
      canRestart: false,
      message:
        `检测到上游端口 ${upstreamPort} 上已有外部启动的 Splash（非本管理端拉起）。本端只读状态；请用本端「启动」前先手动停掉该服务，或继续只看状态，避免误杀。`,
    };
  }

  return {
    kind: 'none',
    managedPid: null,
    meta: null,
    probe,
    upstreamPort,
    canRestart: true,
    message: `当前没有检测到 Splash 在上游端口 ${upstreamPort} 上监听`,
  };
}

/**
 * Build the command that would be run (also used by dry-run).
 */
export function previewCommand(config = loadConfig()) {
  const { binary, args, display } = buildServeArgv(config);
  return { binary, args, display, dryRun: dryRunEnabled() };
}

/**
 * Stop only a managed PID.
 */
export async function stopManaged({ timeoutMs = 8000 } = {}) {
  const pid = readPidFile();
  if (!pid || !pidAlive(pid)) {
    clearPid();
    clearManagedMeta();
    return { ok: true, stopped: false, message: '没有本端管理的 Splash 进程' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: `发送 SIGTERM 失败：${err.message}` };
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) {
      clearPid();
      clearManagedMeta();
      return { ok: true, stopped: true, pid, message: `已停止 PID ${pid}` };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 300));
  clearPid();
  clearManagedMeta();
  if (pidAlive(pid)) {
    return { ok: false, error: `进程 ${pid} 在 SIGKILL 后仍存活，请手动检查` };
  }
  return { ok: true, stopped: true, pid, forced: true, message: `已强制停止 PID ${pid}` };
}

/**
 * Start Splash with whitelist argv. Respects DRY_RUN.
 */
export async function startManaged(config = loadConfig()) {
  const ownership = await ownershipStatus(config);
  if (ownership.kind === 'external') {
    return {
      ok: false,
      error: ownership.message,
      ownership,
    };
  }
  if (ownership.kind === 'managed') {
    return {
      ok: false,
      error: `本端 Splash 已在运行（PID ${ownership.managedPid}）。请先重启或停止。`,
      ownership,
    };
  }

  let argv;
  try {
    argv = buildServeArgv(config);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const port = resolveUpstreamPort(config);
  const host = config.host || '127.0.0.1';
  const conflict = await checkPortConflict(host, port);
  if (conflict.inUse) {
    return {
      ok: false,
      error:
        conflict.message +
        `（这是 Splash 上游端口 ${port}；对外管理页仍在对外端口 /admin。）`,
      command: argv.display,
    };
  }

  if (dryRunEnabled()) {
    writeManagedMeta({
      dryRun: true,
      command: argv.display,
      binary: argv.binary,
      args: argv.args,
      at: new Date().toISOString(),
    });
    return {
      ok: true,
      dryRun: true,
      command: argv.display,
      message:
        'DRY_RUN：未真正拉起模型。已生成白名单命令。去掉 SPLASH_WEB_DRY_RUN 后才会 spawn splash serve。',
    };
  }

  // Resolve binary without shell
  const binary = argv.binary;
  if (binary.includes('/') && !fs.existsSync(binary)) {
    return { ok: false, error: `splash 可执行文件不存在：${binary}` };
  }

  ensureDirs();
  const logPath = path.join(path.dirname(pidPath()), 'splash-serve.log');
  const out = fs.openSync(logPath, 'a');

  let child;
  try {
    child = spawn(binary, argv.args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env },
      shell: false,
    });
  } catch (err) {
    fs.closeSync(out);
    return { ok: false, error: `spawn 失败：${err.message}`, command: argv.display };
  }

  child.unref();
  writePid(child.pid);
  writeManagedMeta({
    pid: child.pid,
    command: argv.display,
    binary: argv.binary,
    args: argv.args,
    logPath,
    at: new Date().toISOString(),
    baseUrl: splashBaseUrl({ host, port }),
  });

  return {
    ok: true,
    dryRun: false,
    pid: child.pid,
    command: argv.display,
    logPath,
    message: `已启动 Splash（PID ${child.pid}）。加载大模型可能需要一段时间，请看 Ready 状态。`,
  };
}

/**
 * Safe restart: only managed processes. External → refuse kill.
 */
export async function restartManaged(config = loadConfig()) {
  const ownership = await ownershipStatus(config);

  if (ownership.kind === 'external') {
    return {
      ok: false,
      error: ownership.message + ' 重启已取消，未向外部进程发送信号。',
      ownership,
      command: previewCommand(config).display,
    };
  }

  if (ownership.kind === 'managed') {
    const stopped = await stopManaged();
    if (!stopped.ok) {
      return { ok: false, error: stopped.error, phase: 'stop' };
    }
  }

  const started = await startManaged(config);
  return {
    ...started,
    phase: 'restart',
    previous: ownership.kind,
  };
}

export { dryRunEnabled, readPidFile, readManagedMeta };
