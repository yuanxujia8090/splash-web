async function api(path, opts = {}) {
  const res = await fetch(path, {
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

function fillConfig(config) {
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
  $('splashBinary').value = config.splashBinary || '';
}

function readForm() {
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
    splashBinary: $('splashBinary').value.trim(),
  };
}

function renderStatus(data) {
  const s = data.probe?.summary || {};
  const verdict = $('verdict');
  verdict.textContent = s.verdictLabel || (data.probe?.reachable ? '未知' : '离线');
  verdict.className = 'verdict ' + (s.verdict || 'offline');

  const rows = [
    ['Ready', data.probe?.ready ? '是' : '否'],
    ['Decode tok/s', s.decodeTokPerSec ?? '—'],
    ['Prefill tok/s', s.prefillTokPerSec ?? '—'],
    ['活跃请求', s.activeRequests ?? 0],
    ['队列', s.queued ?? 0],
    ['HTTP 并发', `${s.httpActive ?? 0}${s.httpCapacity != null ? ' / ' + s.httpCapacity : ''}`],
    ['当前模型', s.model || '—'],
    ['目标', `${data.configTarget?.host}:${data.configTarget?.port}`],
  ];
  $('stats').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');

  $('ownership-msg').textContent = data.ownership?.message || '';
  const can = data.ownership?.canRestart !== false && data.ownership?.kind !== 'external';
  $('btn-restart').disabled = data.ownership?.kind === 'external';
  $('btn-stop').disabled = data.ownership?.kind !== 'managed';
  $('btn-start').disabled = data.ownership?.kind === 'managed' || data.ownership?.kind === 'external';
  void can;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshStatus() {
  const data = await api('/api/status');
  renderStatus(data);
  return data;
}

async function loadModels(selectedPath) {
  const data = await api('/api/models');
  const sel = $('model-select');
  const groups = [
    { label: 'LM Studio (~/.lmstudio/models)', source: 'lmstudio' },
    { label: 'oMLX (~/.omlx/models)', source: 'omlx' },
  ];
  sel.innerHTML = '<option value="">— 从本机已有目录选择 —</option>';
  for (const g of groups) {
    const opts = data.models.filter((m) => m.source === g.source);
    if (!opts.length) continue;
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const m of opts) {
      const o = document.createElement('option');
      o.value = m.path;
      o.textContent = m.label;
      if (selectedPath && m.path === selectedPath) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

async function init() {
  const meta = await api('/api/meta');
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

  const cfg = await api('/api/config');
  fillConfig(cfg.config);
  await loadModels(cfg.config.model);
  await refreshStatus();
}

$('model-select').addEventListener('change', (e) => {
  if (e.target.value) $('model').value = e.target.value;
});

$('btn-refresh').addEventListener('click', () => {
  refreshStatus().catch((err) => {
    $('ownership-msg').textContent = err.message;
  });
});

$('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('config-msg').textContent = '保存中…';
  try {
    const saved = await api('/api/config', { method: 'PUT', body: JSON.stringify(readForm()) });
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
    await api('/api/config', { method: 'PUT', body: JSON.stringify(readForm()) });
    const p = await api('/api/preview-command');
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
  runAction(() => api('/api/restart', { method: 'POST', body: '{}' })),
);
$('btn-start').addEventListener('click', () =>
  runAction(() => api('/api/start', { method: 'POST', body: '{}' })),
);
$('btn-stop').addEventListener('click', () =>
  runAction(() => api('/api/stop', { method: 'POST', body: '{}' })),
);

initTheme();
init().catch((err) => {
  $('verdict').textContent = '管理端初始化失败：' + err.message;
  $('verdict').className = 'verdict offline';
});

setInterval(() => {
  refreshStatus().catch(() => {});
}, 5000);
