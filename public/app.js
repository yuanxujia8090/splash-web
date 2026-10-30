const API = '/admin/api';

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || res.statusText);
    err.data = data;
    throw err;
  }
  return data;
}

function $(id) {
  return document.getElementById(id);
}


const THEME_KEY = 'splash-web-theme';

function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' || t === 'light' ? t : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore quota / private mode */
  }
  const btn = $('btn-theme');
  if (btn) {
    btn.textContent = next === 'dark' ? '浅色' : '深色';
    btn.setAttribute('aria-label', next === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  }
}

function initTheme() {
  applyTheme(getTheme());
  const btn = $('btn-theme');
  if (btn && !btn.dataset.themeBound) {
    btn.dataset.themeBound = '1';
    btn.addEventListener('click', () => {
      applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });
  }
}


function showLog(el, text) {
  el.hidden = !text;
  el.textContent = text || '';
}

function fillConfig(config, upstreamPort) {
  $('model').value = config.model || '';
  $('port').value = config.port ?? 8000;
  $('host').value = config.host || '127.0.0.1';
  $('maxMemory').value = config.maxMemory || '';
  $('maxContext').value = config.maxContext || '';
  $('queueSize').value = config.queueSize ?? 32;
  $('idleRelease').value = config.idleRelease || '';
  $('offline').checked = !!config.offline;
  $('languageOnly').checked = !!config.languageOnly;
  $('noWebui').checked = !!config.noWebui;
  $('useDflash').checked = config.useDflash !== false;
  $('draftModel').value = config.draftModel || '';
  $('splashBinary').value = config.splashBinary || '';
  $('applySamplingDefaults').checked = config.applySamplingDefaults !== false;
  $('temperature').value = config.temperature ?? 1.0;
  $('topP').value = config.topP ?? 0.95;
  $('topK').value = config.topK ?? 20;
  syncDflashUi();
  const hint = $('upstream-hint');
  if (hint) {
    const up = upstreamPort ?? config.upstreamPort ?? 18000;
    hint.textContent = `上游 Splash 端口（只读）：${up} — spawn 时绑定此端口，对外仍走上面的对外端口反代`;
  }
}

function readForm() {
  // 空输入 → '' （saveConfig 会回落到默认值），避免 Number('') = 0 把温度误设成贪心
  const num = (id) => {
    const raw = $(id).value.trim();
    return raw === '' ? '' : Number(raw);
  };
  return {
    model: $('model').value.trim(),
    port: Number($('port').value),
    host: $('host').value.trim(),
    maxMemory: $('maxMemory').value.trim(),
    maxContext: $('maxContext').value.trim(),
    queueSize: Number($('queueSize').value),
    idleRelease: $('idleRelease').value.trim(),
    offline: $('offline').checked,
    languageOnly: $('languageOnly').checked,
    noWebui: $('noWebui').checked,
    useDflash: $('useDflash').checked,
    draftModel: $('draftModel').value.trim(),
    splashBinary: $('splashBinary').value.trim(),
    applySamplingDefaults: $('applySamplingDefaults').checked,
    temperature: num('temperature'),
    topP: num('topP'),
    topK: num('topK'),
  };
}

// 保留 1 位小数：123.456 → 123.5，5 → 5.0，0 → 0.0
function fixed1(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

// 主值已经是平均值时不重复；只有主值走了实时窗口，才把平均挂出来对比
function averageOf(average, source) {
  if (source !== 'window') return null;
  // 注意：不能先 Number(null) —— 那会得到 0，把「还没累计」显示成「平均 0.0」
  if (average === null || average === undefined || average === '') return null;
  const n = Number(average);
  return Number.isFinite(n) ? n : null;
}

// 速度来源标记：让「实时窗口」和「历史平均」一眼可分，别让数值回落被误判成性能掉了
function speedTag(source) {
  if (source === 'window') {
    return {
      label: '实时',
      tone: 'live',
      title: '最近约 1 秒的实测吞吐（对齐 pi-token-speed 的滑动窗口）',
    };
  }
  if (source === 'average') {
    return {
      label: '平均',
      tone: 'avg',
      title: '最近 1 秒没有新增 token，显示 Splash 的累计平均速度',
    };
  }
  return null;
}

function renderStatus(data) {
  const s = data.probe?.summary || {};
  const speed = data.probe?.speed || {};
  const verdict = $('verdict');
  verdict.textContent = s.verdictLabel || (data.probe?.reachable ? '未知' : '离线');
  verdict.className = 'verdict ' + (s.verdict || 'offline');

  const rows = [
    ['Ready', data.probe?.ready ? '是' : '否'],
    ['Decode tok/s', fixed1(s.decodeTokPerSec), speedTag(speed.decodeSource), averageOf(speed.decodeAverageTokPerSec, speed.decodeSource)],
    ['Prefill tok/s', fixed1(s.prefillTokPerSec), speedTag(speed.prefillSource), averageOf(speed.prefillAverageTokPerSec, speed.prefillSource)],
    ['活跃请求', s.activeRequests ?? 0],
    ['队列', s.queued ?? 0],
    ['HTTP 并发', `${s.httpActive ?? 0}${s.httpCapacity != null ? ' / ' + s.httpCapacity : ''}`],
    ['当前模型', s.model || '—'],
    ['对外', `${data.configTarget?.host}:${data.configTarget?.port}`],
    ['上游', String(data.configTarget?.upstreamPort ?? data.ownership?.upstreamPort ?? '—')],
  ];
  const stats = $('stats');
  stats.textContent = '';
  for (const [k, v, tag, average] of rows) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = String(k);
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    if (tag) {
      const badge = document.createElement('span');
      badge.className = 'speed-tag ' + tag.tone;
      badge.textContent = tag.label;
      badge.title = tag.title;
      dd.append(badge);
    }
    if (average !== null) {
      const avg = document.createElement('span');
      avg.className = 'speed-avg';
      avg.textContent = '平均 ' + fixed1(average);
      avg.title = 'Splash 上报的累计平均速度，用来对照实时值';
      dd.append(avg);
    }
    row.append(dt, dd);
    stats.append(row);
  }

  $('ownership-msg').textContent = data.ownership?.message || '';
  const can = data.ownership?.canRestart !== false && data.ownership?.kind !== 'external';
  $('btn-restart').disabled = data.ownership?.kind === 'external';
  $('btn-stop').disabled = data.ownership?.kind !== 'managed';
  $('btn-start').disabled = data.ownership?.kind === 'managed' || data.ownership?.kind === 'external';
  void can;
}

function renderSamplingBaseline(sampling) {
  const el = $('sampling-baseline');
  if (!el || !sampling) return;
  const n = sampling.native || {};
  const r = sampling.ranges || {};
  el.textContent =
    `Splash 原生默认：temperature ${n.temperature} · top_p ${n.top_p} · top_k ${n.top_k}` +
    (r.temperature ? `　范围：温度 ${r.temperature} / top_p ${r.top_p} / top_k ${r.top_k}` : '');
}

async function refreshStatus(options = {}) {
  if (options.resetSpeed) {
    // 先重置平均值再读数；重置失败不影响刷新本身
    await api('/speed/reset', { method: 'POST', body: '{}' }).catch(() => {});
  }
  const data = await api('/status');
  renderStatus(data);
  return data;
}

function syncDflashUi() {
  const on = $('useDflash').checked;
  const wraps = ['draft-select-wrap', 'draft-input-wrap'];
  for (const id of wraps) {
    const el = $(id);
    if (el) el.style.opacity = on ? '1' : '0.45';
  }
  $('draft-select').disabled = !on;
  $('draftModel').disabled = !on;
  const hint = $('dflash-hint');
  if (hint) {
    hint.textContent = on
      ? '开启：启动/重启会带上所选 draft（本地路径 → prepare draft=；HF id → --draft-model）。'
      : '关闭：不强制 draft。splash serve 仍可能按模型家族自动选 DFlash2；本地 prepare 不传 draft=。';
  }
}

async function loadModels(selectedPath, selectedDraft) {
  const data = await api('/models');
  const sel = $('model-select');
  const draftSel = $('draft-select');
  const groups = [
    { label: 'LM Studio (~/.lmstudio/models)', source: 'lmstudio' },
    { label: 'oMLX (~/.omlx/models)', source: 'omlx' },
  ];
  sel.innerHTML = '<option value="">— 从本机已有目录选择 —</option>';
  draftSel.innerHTML = '<option value="">— 选择 DFlash2 draft —</option>';
  for (const g of groups) {
    const opts = data.models.filter((m) => m.source === g.source);
    if (!opts.length) continue;
    const og = document.createElement('optgroup');
    og.label = g.label;
    const dog = document.createElement('optgroup');
    dog.label = g.label + ' · DFlash';
    let hasDraft = false;
    for (const m of opts) {
      const o = document.createElement('option');
      o.value = m.path;
      o.textContent = m.dflash ? `${m.label} 〔DFlash2〕` : m.label;
      if (selectedPath && m.path === selectedPath) o.selected = true;
      og.appendChild(o);
      if (m.dflash) {
        hasDraft = true;
        const d = document.createElement('option');
        d.value = m.path;
        d.textContent = m.label;
        if (selectedDraft && m.path === selectedDraft) d.selected = true;
        dog.appendChild(d);
      }
    }
    sel.appendChild(og);
    if (hasDraft) draftSel.appendChild(dog);
  }
}

async function init() {
  const meta = await api('/meta');
  const badges = $('meta-badges');
  badges.innerHTML = '';
  const pills = [
    meta.dryRun ? ['DRY_RUN', 'warn'] : ['live spawn', 'ok'],
    ['localhost', 'ok'],
    ['no shell', 'ok'],
  ];
  for (const [t, cls] of pills) {
    const span = document.createElement('span');
    span.className = 'pill ' + cls;
    span.textContent = t;
    badges.appendChild(span);
  }
  $('config-path').textContent = meta.configPath;
  renderSamplingBaseline(meta.sampling);

  const cfg = await api('/config');
  fillConfig(cfg.config, cfg.upstreamPort);
  await loadModels(cfg.config.model, cfg.config.draftModel);
  await refreshStatus();
}

$('model-select').addEventListener('change', (e) => {
  if (e.target.value) $('model').value = e.target.value;
});

$('draft-select').addEventListener('change', (e) => {
  if (e.target.value) $('draftModel').value = e.target.value;
});

$('useDflash').addEventListener('change', () => syncDflashUi());

$('btn-refresh').addEventListener('click', () => {
  // 手动刷新 = 平均值重新开始累计（自动轮询不重置）
  refreshStatus({ resetSpeed: true }).catch((err) => {
    $('ownership-msg').textContent = err.message;
  });
});

$('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('config-msg').textContent = '保存中…';
  try {
    const saved = await api('/config', { method: 'PUT', body: JSON.stringify(readForm()) });
    $('config-msg').textContent = saved.message || '已保存。需重启才生效。';
    showLog($('preview'), saved.previewCommand || '');
    await refreshStatus();
  } catch (err) {
    $('config-msg').textContent = err.message;
  }
});

$('btn-preview').addEventListener('click', async () => {
  try {
    // save-less preview: put then get would mutate; use current saved + show form note
    await api('/config', { method: 'PUT', body: JSON.stringify(readForm()) });
    const p = await api('/preview-command');
    showLog($('preview'), (p.dryRun ? '[DRY_RUN] ' : '') + p.display);
    $('config-msg').textContent = '已保存并预览。需重启才生效。';
  } catch (err) {
    $('config-msg').textContent = err.message;
  }
});

async function runAction(fn) {
  const log = $('action-log');
  showLog(log, '执行中…');
  try {
    const result = await fn();
    showLog(log, JSON.stringify(result, null, 2));
    await refreshStatus();
  } catch (err) {
    showLog(log, err.data ? JSON.stringify(err.data, null, 2) : err.message);
  }
}

$('btn-restart').addEventListener('click', () =>
  runAction(() => api('/restart', { method: 'POST', body: '{}' })),
);
$('btn-start').addEventListener('click', () =>
  runAction(() => api('/start', { method: 'POST', body: '{}' })),
);
$('btn-stop').addEventListener('click', () =>
  runAction(() => api('/stop', { method: 'POST', body: '{}' })),
);

const shutdownConfirm = $('shutdown-confirm');
$('btn-shutdown').addEventListener('click', () => {
  shutdownConfirm.hidden = false;
  $('shutdown-msg').textContent = '';
});
$('btn-shutdown-no').addEventListener('click', () => {
  shutdownConfirm.hidden = true;
  $('shutdown-msg').textContent = '';
});
$('btn-shutdown-yes').addEventListener('click', async () => {
  const msg = $('shutdown-msg');
  msg.textContent = '正在关闭整体服务…';
  $('btn-shutdown-yes').disabled = true;
  $('btn-shutdown').disabled = true;
  try {
    const result = await api('/shutdown', { method: 'POST', body: '{}' });
    msg.textContent =
      (result.message || '已关闭') +
      ' 若页面不再响应即表示 splash-web 已退出；可用 lsof -iTCP:8000 -sTCP:LISTEN 确认端口已释放。';
  } catch (err) {
    // Connection drop after exit is expected success
    const dropped =
      err?.name === 'TypeError' ||
      /Failed to fetch|NetworkError|load failed|ECONNREFUSED/i.test(String(err?.message || err));
    if (dropped) {
      msg.textContent = '连接已断开：整体服务应已关闭。可用 lsof -iTCP:8000 -sTCP:LISTEN 确认。';
      return;
    }
    msg.textContent = err.data ? JSON.stringify(err.data) : err.message;
    $('btn-shutdown-yes').disabled = false;
    $('btn-shutdown').disabled = false;
  }
});

initTheme();
init().catch((err) => {
  $('verdict').textContent = '管理端初始化失败：' + err.message;
  $('verdict').className = 'verdict offline';
});

setInterval(() => {
  refreshStatus().catch(() => {});
}, 5000);
