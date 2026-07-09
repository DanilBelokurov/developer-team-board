// devteam-board frontend.
// Polls /api/tickets every 2 seconds, renders 7 columns, supports new-ticket
// and detail modal with Log / Reasoning / Tools / Events tabs and session resume.

const POLL_MS = 2000;

const COLUMNS = [
  { status: 'backlog',      el: document.getElementById('col-backlog') },
  { status: 'analytics',    el: document.getElementById('col-analytics') },
  { status: 'development',  el: document.getElementById('col-development') },
  { status: 'testing',      el: document.getElementById('col-testing') },
  { status: 'admin',        el: document.getElementById('col-admin') },
  { status: 'completed',    el: document.getElementById('col-completed') },
  { status: 'failed',       el: document.getElementById('col-failed') },
];

const state = { tickets: [], currentDetail: null, logOffset: 0, logTimer: null, activeTab: 'log' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function columnFor(t) {
  if (t.status === 'running') return t.stage || 'analytics';
  if (t.status === 'awaiting_approval') return t.stage || 'analytics';
  if (t.status === 'cancelled') return 'failed';
  return t.status;
}

async function fetchBoard() {
  try {
    const r = await fetch('/api/tickets');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.tickets = await r.json();
    $('#conn-status').textContent = 'live';
    $('#conn-status').className = 'conn-status ok';
  } catch (e) {
    $('#conn-status').textContent = 'offline';
    $('#conn-status').className = 'conn-status err';
    return;
  }
  render();
  if (state.currentDetail) {
    const updated = state.tickets.find((x) => x.id === state.currentDetail.id);
    if (updated && updated !== state.currentDetail) {
      state.currentDetail = updated;
      renderMeta();
      renderTabs();
      renderMetrics();
      renderResumeButton();
    }
  }
}

function render() {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.status, []]));
  for (const t of state.tickets) {
    const col = columnFor(t);
    if (groups[col]) groups[col].push(t);
  }
  for (const c of COLUMNS) {
    c.el.innerHTML = '';
    for (const t of groups[c.status]) c.el.appendChild(cardEl(t));
  }
}

function cardEl(t) {
  const el = document.createElement('div');
  el.className = `card status-${t.status}`;
  el.dataset.id = t.id;
  const age = t.lastActivityAt ? humanAge(Date.now() - t.lastActivityAt) : '';
  el.innerHTML = `
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-sub">
      <code class="branch">${esc(t.branch)}</code>
      ${t.substage ? `<span class="substage">${esc(t.substage)}</span>` : ''}
      ${t.status === 'awaiting_approval' ? '<span class="badge hitl">HITL</span>' : ''}
      ${t.sessionId ? '<span class="badge resume" title="qwen session id stored — can be resumed">↻</span>' : ''}
    </div>
    <div class="card-meta">
      <span>${esc(t.id)}</span>
      <span class="muted">${age}</span>
    </div>
  `;
  el.addEventListener('click', () => openDetail(t.id));
  return el;
}

function humanAge(ms) {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// --- New ticket modal -----------------------------------------------------

$('#new-ticket-btn').addEventListener('click', () => $('#new-ticket-modal').classList.remove('hidden'));
$('#new-ticket-cancel').addEventListener('click', () => $('#new-ticket-modal').classList.add('hidden'));
$('#new-ticket-modal').addEventListener('click', (e) => {
  if (e.target.id === 'new-ticket-modal') $('#new-ticket-modal').classList.add('hidden');
});

async function loadProjects() {
  const dl = document.getElementById('projects-list');
  const hint = document.getElementById('workdir-hint');
  if (!dl) return;
  try {
    const r = await fetch('/api/projects');
    const data = await r.json();
    dl.innerHTML = '';
    for (const p of (data.projects || [])) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.label = p.name;
      dl.appendChild(opt);
    }
    if (hint) {
      if (data.projects && data.projects.length) {
        hint.textContent = `${data.projects.length} repo(s) under ${data.root}`;
      } else if (data.error) {
        hint.textContent = `scan root ${data.root}: ${data.error}`;
      } else {
        hint.textContent = `no git repos found under ${data.root} — type a path manually`;
      }
    }
  } catch (e) {
    if (hint) hint.textContent = `could not load projects: ${e.message || e}`;
  }
}
loadProjects();

const noNewBranchEl = document.getElementById('no-new-branch');
const branchInputEl = document.querySelector('#new-ticket-form input[name="branch"]');
function syncNoNewBranch() {
  if (!noNewBranchEl || !branchInputEl) return;
  branchInputEl.disabled = noNewBranchEl.checked;
  if (noNewBranchEl.checked) branchInputEl.value = '';
}
noNewBranchEl && noNewBranchEl.addEventListener('change', syncNoNewBranch);
syncNoNewBranch();

$('#new-ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    title: fd.get('title'),
    workdir: fd.get('workdir'),
    base: fd.get('base') || 'main',
    branch: fd.get('branch') || undefined,
    noNewBranch: fd.get('noNewBranch') === 'on',
  };
  const r = await fetch('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(`Failed to create ticket: ${err.message || err.error || r.statusText}`);
    return;
  }
  $('#new-ticket-modal').classList.add('hidden');
  e.target.reset();
  syncNoNewBranch();
  fetchBoard();
});

// --- Detail modal ---------------------------------------------------------

$('#detail-close').addEventListener('click', closeDetail);
$('#detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'detail-modal') closeDetail();
});
$('#btn-refresh').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  const r = await fetch(`/api/tickets/${state.currentDetail.id}`);
  if (r.ok) {
    state.currentDetail = await r.json();
    renderMeta();
    renderTabs();
    renderMetrics();
    renderResumeButton();
  }
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.tab !== name);
  });
}

$('#btn-cancel').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  if (!confirm('Cancel the pipeline? The worktree will be kept.')) return;
  await fetch(`/api/tickets/${state.currentDetail.id}/cancel`, { method: 'POST' });
  fetchBoard();
  await openDetail(state.currentDetail.id);
});

$('#btn-delete').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  if (!confirm('Kill the qwen process and remove the worktree? This cannot be undone.')) return;
  await fetch(`/api/tickets/${state.currentDetail.id}`, { method: 'DELETE' });
  closeDetail();
  fetchBoard();
});

$('#btn-resume').addEventListener('click', () => {
  if (!state.currentDetail) return;
  $('#resume-modal').classList.remove('hidden');
  $('#resume-form [name="prompt"]').value = '';
  $('#resume-form [name="prompt"]').focus();
});

$('#resume-cancel').addEventListener('click', () => $('#resume-modal').classList.add('hidden'));
$('#resume-modal').addEventListener('click', (e) => {
  if (e.target.id === 'resume-modal') $('#resume-modal').classList.add('hidden');
});

$('#resume-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentDetail) return;
  const fd = new FormData(e.target);
  const prompt = (fd.get('prompt') || '').toString().trim() || 'Continue from where we left off.';
  const r = await fetch(`/api/tickets/${state.currentDetail.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(`Failed to resume: ${err.message || err.error || r.statusText}`);
    return;
  }
  $('#resume-modal').classList.add('hidden');
  state.currentDetail = await r.json();
  state.logOffset = 0;
  renderMeta();
  renderTabs();
  renderMetrics();
  renderResumeButton();
  fetchBoard();
});

async function openDetail(id) {
  const r = await fetch(`/api/tickets/${id}`);
  if (!r.ok) return;
  const t = await r.json();
  state.currentDetail = t;
  state.logOffset = 0;
  $('#detail-title').textContent = t.title;
  $('#detail-modal').classList.remove('hidden');
  renderMeta();
  renderTabs();
  renderMetrics();
  renderResumeButton();
  await pollLogs();
  if (state.logTimer) clearInterval(state.logTimer);
  state.logTimer = setInterval(pollLogs, 1500);
}

function closeDetail() {
  $('#detail-modal').classList.add('hidden');
  state.currentDetail = null;
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
}

function renderMeta() {
  const t = state.currentDetail;
  if (!t) return;
  const stages = ['analytics', 'development', 'testing', 'admin'].map((s) => {
    const done = (t.stagesCompleted || []).includes(s);
    const cur = t.stage === s;
    return `<span class="stage-pill ${done ? 'done' : ''} ${cur ? 'cur' : ''}">${s}</span>`;
  }).join(' → ');
  $('#detail-meta').innerHTML = `
    <dl>
      <dt>ID</dt><dd><code>${esc(t.id)}</code></dd>
      <dt>Status</dt><dd><span class="badge status-${t.status}">${esc(t.status)}</span></dd>
      <dt>Stage</dt><dd>${stages}</dd>
      <dt>Substage</dt><dd>${esc(t.substage || '—')}</dd>
      <dt>Branch</dt><dd><code>${esc(t.branch)}</code></dd>
      <dt>Plan ID</dt><dd><code>${esc(t.planId)}</code></dd>
      <dt>Worktree</dt><dd><code class="path">${esc(t.worktreePath)}</code></dd>
      <dt>qwen PID</dt><dd>${t.qwenPid ?? '—'}</dd>
      ${t.exitCode !== null && t.exitCode !== undefined ? `<dt>Exit</dt><dd>code=${esc(t.exitCode)} signal=${esc(t.exitSignal || '')}</dd>` : ''}
      ${t.failureReason ? `<dt>Failure</dt><dd class="err">${esc(t.failureReason)}</dd>` : ''}
      ${t.hitlReason ? `<dt>HITL</dt><dd>${esc(t.hitlReason)}</dd>` : ''}
      ${t.sessionId ? `<dt>Session</dt><dd><code class="path" title="qwen session id (for --resume)">${esc(t.sessionId.slice(0, 16))}…</code></dd>` : ''}
      ${t.analysisPath ? `<dt>Analysis</dt><dd><a href="file://${esc(t.analysisPath)}" target="_blank">open</a></dd>` : ''}
      ${t.stage2MergePath ? `<dt>Stage 2 merge</dt><dd><a href="file://${esc(t.stage2MergePath)}" target="_blank">open</a></dd>` : ''}
    </dl>
  `;
}

function renderResumeButton() {
  const t = state.currentDetail;
  const btn = $('#btn-resume');
  if (!t || !btn) return;
  const canResume = t.sessionId && t.worktreePath && !['running'].includes(t.status);
  btn.classList.toggle('hidden', !canResume);
}

function renderMetrics() {
  const t = state.currentDetail;
  const el = $('#metrics');
  if (!t || !el) return;
  const u = t.usage || {};
  const parts = [];
  if (t.numTurns != null) parts.push(`<span><b>${t.numTurns}</b> turns</span>`);
  if (u.input_tokens != null) parts.push(`<span><b>${fmtNum(u.input_tokens)}</b> in</span>`);
  if (u.output_tokens != null) parts.push(`<span><b>${fmtNum(u.output_tokens)}</b> out</span>`);
  if (u.cache_read_input_tokens != null) parts.push(`<span><b>${fmtNum(u.cache_read_input_tokens)}</b> cache</span>`);
  if (t.durationMs != null) parts.push(`<span><b>${(t.durationMs / 1000).toFixed(1)}s</b> wall</span>`);
  if (t.apiDurationMs != null) parts.push(`<span><b>${(t.apiDurationMs / 1000).toFixed(1)}s</b> api</span>`);
  el.innerHTML = parts.length ? parts.join('') + (t.resultError ? ` <span class="err">err: ${esc(t.resultError.message || '')}</span>` : '') : '';
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function renderTabs() {
  const t = state.currentDetail;
  if (!t) return;
  // Reasoning
  const reasonList = $('#reasoning');
  const reasonEmpty = $('#reasoning-empty');
  const thinking = t.thinking || [];
  $('#count-reasoning').textContent = thinking.length ? `(${thinking.length})` : '';
  if (reasonList) {
    reasonList.innerHTML = thinking.map((th) => `
      <li class="thinking-item">
        <div class="thinking-text">${esc(th.text)}</div>
        <div class="thinking-meta">${humanAge(Date.now() - th.at)}</div>
      </li>
    `).join('');
    if (reasonEmpty) reasonEmpty.style.display = thinking.length ? 'none' : '';
  }
  // Tools
  const toolsList = $('#tools');
  const toolsEmpty = $('#tools-empty');
  const calls = t.toolCalls || [];
  $('#count-tools').textContent = calls.length ? `(${calls.length})` : '';
  if (toolsList) {
    toolsList.innerHTML = calls.map((c) => {
      const stageBadge = c.stage ? `<span class="stage-badge stage-${esc(c.stage.id)}">${esc(c.stage.label || c.stage.id)}</span>` : '';
      const errClass = c.isError ? ' tool-error' : '';
      const inputStr = c.input ? JSON.stringify(c.input, null, 2) : '';
      const outStr = c.output || (c.output === null ? '' : '');
      const outHtml = c.output == null
        ? '<span class="muted">…pending</span>'
        : `<pre>${esc(outStr)}</pre>`;
      const dur = c.finishedAt && c.at ? `${humanAge(c.finishedAt - c.at)}` : '';
      return `
        <li class="tool-item${errClass}">
          <div class="tool-head">
            <span class="tool-name">${esc(c.name)}</span>
            ${stageBadge}
            ${dur ? `<span class="muted">${dur}</span>` : ''}
            ${c.isError ? '<span class="badge err">error</span>' : ''}
          </div>
          ${inputStr ? `<details><summary>input</summary><pre>${esc(inputStr)}</pre></details>` : ''}
          <details><summary>output</summary>${outHtml}</details>
        </li>
      `;
    }).join('');
    if (toolsEmpty) toolsEmpty.style.display = calls.length ? 'none' : '';
  }
  // Events
  const eventsList = $('#events');
  const evs = t.events || [];
  $('#count-events').textContent = evs.length ? `(${evs.length})` : '';
  if (eventsList) {
    eventsList.innerHTML = evs.slice().reverse().map((e) => `
      <li class="event-item kind-${esc(e.kind || e.type)}">
        <span class="event-kind">${esc(e.kind || e.type)}</span>
        <span class="muted">${humanAge(Date.now() - (e.at || 0))}</span>
        <pre>${esc(JSON.stringify(e, null, 2))}</pre>
      </li>
    `).join('');
  }
}

async function pollLogs() {
  if (!state.currentDetail) return;
  const id = state.currentDetail.id;
  const r = await fetch(`/api/tickets/${id}/logs?since=${state.logOffset}`);
  if (!r.ok) return;
  const { lines, total } = await r.json();
  if (lines.length) {
    const pre = $('#logs');
    pre.textContent += lines.join('\n') + '\n';
    pre.scrollTop = pre.scrollHeight;
  }
  state.logOffset = total;
  $('#logs-status').textContent = `(${total} lines)`;
}

// --- Boot -----------------------------------------------------------------

setInterval(fetchBoard, POLL_MS);
fetchBoard();
