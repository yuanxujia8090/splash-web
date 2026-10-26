/**
 * Manage Splash processes spawned by this admin only.
 * Never shell:true. Never kill unmanaged PIDs without explicit policy.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLaunchPlan,
  expandUser,
  isLocalModelPath,
} from './whitelist.js';
import {
  ensureDirs,
  loadConfig,
  managedMetaPath,
  pidPath,
  resolveUpstreamPort,
  runtimeDir,
} from './config.js';
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

function lastFailurePath() {
  return path.join(runtimeDir(), 'last-start-failure.json');
}

function writeLastFailure(info) {
  ensureDirs();
  fs.writeFileSync(lastFailurePath(), JSON.stringify(info, null, 2) + '\n', 'utf8');
}

function clearLastFailure() {
  try {
    fs.unlinkSync(lastFailurePath());
  } catch {
    /* ignore */
  }
}

function readLastFailure() {
  try {
    return JSON.parse(fs.readFileSync(lastFailurePath(), 'utf8'));
  } catch {
    return null;
  }
}

function serveLogPath() {
  return path.join(runtimeDir(), 'splash-serve.log');
}

function readLogTail(logFile, maxBytes = 4000) {
  try {
    const st = fs.statSync(logFile);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function extractReadableError(logTail) {
  if (!logTail) return '进程已退出，日志为空';
  const lines = logTail.split(/\r?\n/).filter(Boolean);
  const interesting = [...lines].reverse().find((l) =>
    /error:|Error|Traceback|cannot prepare|ModelError|argument --model|failed/i.test(l),
  );
  if (interesting) return interesting.slice(0, 500);
  return lines.slice(-8).join('\n').slice(0, 800);
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

  const failure = readLastFailure();
  if (failure && failure.at) {
    const ageMs = Date.now() - Date.parse(failure.at);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) {
      const summary = failure.error || failure.logSummary || '见 splash-serve.log';
      return {
        kind: 'none',
        managedPid: null,
        meta: null,
        probe,
        upstreamPort,
        canRestart: true,
        lastFailure: failure,
        message: `当前没有检测到 Splash 在上游端口 ${upstreamPort} 上监听。最近一次启动失败：${summary}`,
      };
    }
  }

  return {
    kind: 'none',
    managedPid: null,
    meta: null,
    probe,
    upstreamPort,
    canRestart: true,
    message: `当前没有检测到 Splash 在上游端口 ${upstreamPort} 上监听（尚未启动）`,
  };
}

/**
 * Build the command that would be run (also used by dry-run).
 */
export function previewCommand(config = loadConfig()) {
  const plan = buildLaunchPlan(config, { prepareLocal: false });
  return {
    binary: plan.binary,
    args: plan.args,
    display: plan.display,
    mode: plan.mode,
    modelId: plan.modelId,
    draftNote: plan.draftNote,
    dryRun: dryRunEnabled(),
  };
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
 * Call Splash install.local.prepare_local_model (same idea as run-splash-local.sh).
 * @param {{ localPath: string, draft: string|null, libexec: string, languageOnly?: boolean }} opts
 */
export function prepareLocalModel({ localPath, draft, libexec, languageOnly = false }) {
  const python = path.join(libexec, 'python', 'bin', 'python3');
  if (!fs.existsSync(python)) {
    return { ok: false, error: `Splash python 不存在：${python}（libexec=${libexec}）` };
  }
  const draftArg = draft ? expandUser(draft) : '';
  if (draftArg && !fs.existsSync(draftArg)) {
    return { ok: false, error: `DFlash2 draft 目录不存在：${draftArg}` };
  }

  const script = [
    'import sys, json',
    'root, model, draft, language_only = sys.argv[1:5]',
    'sys.path.insert(0, root)',
    'from install.local import prepare_local_model',
    'kwargs = {}',
    'if draft:',
    '    kwargs["draft"] = draft',
    'if language_only == "1":',
    '    kwargs["language_only"] = True',
    'prepared = prepare_local_model(model, **kwargs)',
    'print(prepared)',
  ].join('\n');

  const result = spawnSync(
    python,
    ['-', libexec, localPath, draftArg, languageOnly ? '1' : '0'],
    {
      input: script,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: libexec,
        PYTHONUNBUFFERED: '1',
        TRANSFORMERS_VERBOSITY: 'error',
      },
      shell: false,
      timeout: 10 * 60 * 1000,
    },
  );

  if (result.error) {
    return { ok: false, error: `prepare_local_model 无法执行：${result.error.message}` };
  }
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (result.status !== 0) {
    const detail = extractReadableError(stderr || stdout) || `exit ${result.status}`;
    return {
      ok: false,
      error: `prepare_local_model 失败：${detail}`,
      stderr: stderr.slice(-2000),
    };
  }
  const prepared = stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (!prepared || !fs.existsSync(prepared)) {
    return {
      ok: false,
      error: `prepare_local_model 未返回有效目录：${prepared || '(empty)'}`,
      stderr: stderr.slice(-2000),
    };
  }
  return {
    ok: true,
    preparedDir: prepared,
    draftUsed: draftArg || null,
    note: draftArg
      ? `已用本地 draft=${draftArg}`
      : '未传 draft=，交由 Splash prepare 默认逻辑（可能查 HF cache）',
  };
}

/**
 * Start Splash with whitelist argv. Respects DRY_RUN.
 * Local absolute model paths use prepare_local_model + server.server.
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

  let plan;
  try {
    plan = buildLaunchPlan(config, { prepareLocal: false });
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
      command: plan.display,
    };
  }

  if (dryRunEnabled()) {
    writeManagedMeta({
      dryRun: true,
      command: plan.display,
      binary: plan.binary,
      args: plan.args,
      mode: plan.mode,
      draftNote: plan.draftNote,
      at: new Date().toISOString(),
    });
    return {
      ok: true,
      dryRun: true,
      command: plan.display,
      mode: plan.mode,
      draftNote: plan.draftNote,
      message:
        'DRY_RUN：未真正拉起模型。已生成白名单命令。去掉 SPLASH_WEB_DRY_RUN 后才会 spawn。',
    };
  }

  let preparedInfo = null;
  if (plan.mode === 'local') {
    preparedInfo = prepareLocalModel({
      localPath: plan.localPath,
      draft: plan.draft,
      libexec: plan.libexec,
      languageOnly: config.languageOnly === true,
    });
    if (!preparedInfo.ok) {
      const failure = {
        at: new Date().toISOString(),
        phase: 'prepare',
        error: preparedInfo.error,
        mode: 'local',
        model: config.model,
        draft: plan.draft,
      };
      writeLastFailure(failure);
      return { ok: false, error: preparedInfo.error, phase: 'prepare', draftNote: plan.draftNote };
    }
    plan = buildLaunchPlan(config, {
      prepareLocal: false,
      preparedDir: preparedInfo.preparedDir,
    });
  }

  if (plan.mode === 'serve') {
    const binary = plan.binary;
    if (binary.includes('/') && !fs.existsSync(binary)) {
      return { ok: false, error: `splash 可执行文件不存在：${binary}` };
    }
  } else {
    if (!fs.existsSync(plan.binary)) {
      return { ok: false, error: `Splash python 不存在：${plan.binary}` };
    }
  }

  ensureDirs();
  const logPath = serveLogPath();
  const out = fs.openSync(logPath, 'a');
  fs.writeSync(
    out,
    `\n==== splash-web start ${new Date().toISOString()} mode=${plan.mode} ====\n${plan.display}\n${plan.draftNote}\n`,
  );

  let child;
  try {
    child = spawn(plan.binary, plan.args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...plan.env },
      shell: false,
      cwd: plan.libexec || undefined,
    });
  } catch (err) {
    try {
      fs.closeSync(out);
    } catch {
      /* ignore */
    }
    const failure = {
      at: new Date().toISOString(),
      phase: 'spawn',
      error: `spawn 失败：${err.message}`,
      mode: plan.mode,
      command: plan.display,
    };
    writeLastFailure(failure);
    return { ok: false, error: failure.error, command: plan.display };
  }

  // Parent no longer needs the fd; child keeps it.
  try {
    fs.closeSync(out);
  } catch {
    /* ignore */
  }

  child.unref();
  writePid(child.pid);
  writeManagedMeta({
    pid: child.pid,
    command: plan.display,
    binary: plan.binary,
    args: plan.args,
    mode: plan.mode,
    modelId: plan.modelId,
    preparedDir: preparedInfo?.preparedDir || null,
    draft: plan.draft,
    draftNote: plan.draftNote,
    logPath,
    at: new Date().toISOString(),
    baseUrl: splashBaseUrl({ host, port }),
  });

  // Post-start check: refuse fake ok if process dies immediately (CLI validation etc.)
  const waitMs = Number(process.env.SPLASH_WEB_START_WAIT_MS) || 1800;
  await new Promise((r) => setTimeout(r, waitMs));

  if (!pidAlive(child.pid)) {
    clearPid();
    clearManagedMeta();
    const logTail = readLogTail(logPath);
    const readable = extractReadableError(logTail);
    const failure = {
      at: new Date().toISOString(),
      phase: 'post-start',
      error: readable,
      logSummary: readable,
      logPath,
      mode: plan.mode,
      command: plan.display,
      pid: child.pid,
    };
    writeLastFailure(failure);
    return {
      ok: false,
      error: `Splash 启动后立即退出：${readable}`,
      phase: 'post-start',
      logPath,
      logTail: logTail.slice(-1500),
      command: plan.display,
      draftNote: plan.draftNote,
    };
  }

  clearLastFailure();
  return {
    ok: true,
    dryRun: false,
    pid: child.pid,
    command: plan.display,
    mode: plan.mode,
    modelId: plan.modelId,
    preparedDir: preparedInfo?.preparedDir || null,
    draftNote: plan.draftNote,
    logPath,
    message:
      plan.mode === 'local'
        ? `已通过本地 prepare 启动 Splash（PID ${child.pid}，model id ${plan.modelId}）。大模型加载可能较久，请看 Ready。`
        : `已启动 Splash（PID ${child.pid}）。加载大模型可能需要一段时间，请看 Ready 状态。`,
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

export {
  dryRunEnabled,
  readPidFile,
  readManagedMeta,
  readLastFailure,
};
