/**
 * Read-only client for Splash status APIs.
 */

/**
 * @param {string} baseUrl e.g. http://127.0.0.1:8000
 * @param {number} timeoutMs
 */
async function fetchJson(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? '超时' : err.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {{ host?: string, port?: number }} target
 */
export function splashBaseUrl(target) {
  const host = target.host || '127.0.0.1';
  const port = target.port || 8000;
  const h = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${h}:${port}`;
}

/**
 * Summarize /status for the UI: ready, speed, concurrency/queue.
 * @param {any} status
 */
export function summarizeStatus(status) {
  if (!status || typeof status !== 'object') {
    return {
      ready: false,
      verdict: 'offline',
      verdictLabel: '连不上 Splash',
      model: null,
      host: null,
      port: null,
      decodeTokPerSec: null,
      prefillTokPerSec: null,
      activeRequests: 0,
      queued: 0,
      httpActive: 0,
      httpCapacity: null,
    };
  }

  const metrics = status.metrics || {};
  const scheduler = status.scheduler || {};
  const http = status.http || {};
  const instance = status.instance || {};
  const admission = status.admission || {};
  const activeList = Array.isArray(status.active_requests) ? status.active_requests : [];

  const decodeTok = Number(metrics.decode_tokens_per_second) || 0;
  const prefillTok = Number(metrics.prefill_tokens_per_second) || 0;
  const currentDecode = metrics.current_decode_batch?.tokens_per_second || 0;
  const currentPrefill = metrics.current_prefill_batch?.tokens_per_second || 0;

  const displayDecode = currentDecode || decodeTok;
  const displayPrefill = currentPrefill || prefillTok;

  const queued =
    Number(scheduler.queued) ||
    Number(admission.waiting) ||
    0;
  const active =
    activeList.length ||
    Number(http.requests?.active) ||
    Number(scheduler.prefilling) + Number(scheduler.decode_batches) ||
    0;

  const ready = Boolean(status.ready);
  let verdict = 'idle';
  let verdictLabel = '空闲（Ready，无活跃请求）';

  if (!ready) {
    verdict = 'not_ready';
    verdictLabel = '未 Ready（可能在加载或已释放权重）';
  } else if (active > 0 || displayDecode > 0 || displayPrefill > 0 || Number(scheduler.prefilling) > 0) {
    verdict = 'computing';
    verdictLabel = '在算（有活跃请求或吞吐）';
  } else if (queued > 0) {
    verdict = 'queued';
    verdictLabel = '排队中';
  } else if (status.weights?.released && !status.weights?.restoring) {
    verdict = 'idle_released';
    verdictLabel = 'Ready 但权重已空闲释放（下一请求会 restore）';
  }

  return {
    ready,
    verdict,
    verdictLabel,
    model: instance.model || status.memory_plan?.model?.model_name || null,
    host: instance.host || null,
    port: instance.port || null,
    decodeTokPerSec: displayDecode,
    prefillTokPerSec: displayPrefill,
    activeRequests: active,
    queued,
    httpActive: Number(http.requests?.active) || 0,
    httpCapacity: http.requests?.capacity ?? null,
    memoryPressure: status.memory_pressure || null,
    thermalState: status.thermal_state || null,
    maximumContextTokens: status.maximum_context_tokens || null,
  };
}

/**
 * @param {{ host?: string, port?: number }} target
 */
export async function probeSplash(target) {
  const base = splashBaseUrl(target);
  const [ready, health, status] = await Promise.all([
    fetchJson(`${base}/ready`),
    fetchJson(`${base}/health`),
    fetchJson(`${base}/status`, 3000),
  ]);

  const reachable = ready.ok || health.ok || status.ok;
  const summary = summarizeStatus(status.body);

  return {
    baseUrl: base,
    reachable,
    ready: ready.ok && (ready.body?.status === 'ready' || ready.body?.ready === true || summary.ready),
    readyRaw: ready,
    healthRaw: health,
    statusRawOk: status.ok,
    summary,
    status: status.ok ? status.body : null,
    error: reachable ? null : (status.error || ready.error || health.error || '无法连接'),
  };
}

/**
 * Check if a TCP port is already bound (best-effort via fetch or net).
 */
export async function checkPortConflict(host, port, excludeSplashProbe = true) {
  // Use Node net to see if something accepts connections
  const net = await import('node:net');
  const h = host === '0.0.0.0' ? '127.0.0.1' : host || '127.0.0.1';
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: h, port, timeout: 500 });
    socket.on('connect', () => {
      socket.destroy();
      resolve({
        inUse: true,
        message: `端口 ${port} 已被占用。请换一个端口，或先停掉占用该端口的进程后再启动。`,
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ inUse: false });
    });
    socket.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') resolve({ inUse: false });
      else resolve({ inUse: true, message: `探测端口 ${port} 时出错：${err.message}` });
    });
  });
}
