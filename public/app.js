// devteam-board frontend.
// Polls /api/tickets every 2 seconds, renders 7 columns, supports new-ticket and detail modal.
// Vanilla JS, no framework, no build step.

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

const state = { tickets: [], currentDetail: null, logOffset: 0, logTimer: null };

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

$('#new-ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    title: fd.get('title'),
    workdir: fd.get('workdir'),
    base: fd.get('base') || 'main',
    branch: fd.get('branch') || undefined,
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
  fetchBoard();
});

// --- Detail modal ---------------------------------------------------------

$('#detail-close').addEventListener('click', closeDetail);
$('#detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'detail-modal') closeDetail();
});
$('#btn-refresh').addEventListener('click', () => state.currentDetail && openDetail(state.currentDetail.id));

$('#btn-cancel').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  if (!confirm('Cancel the pipeline? The worktree will be kept.')) return;
  await fetch(`/api/tickets/${state.currentDetail.id}/cancel`, { method: 'POST' });
  fetchBoard();
  openDetail(state.currentDetail.id);
});

$('#btn-delete').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  if (!confirm('Kill the qwen process and remove the worktree? This cannot be undone.')) return;
  await fetch(`/api/tickets/${state.currentDetail.id}`, { method: 'DELETE' });
  closeDetail();
  fetchBoard();
});

async function openDetail(id) {
  const t = state.tickets.find((x) => x.id === id);
  if (!t) return;
  state.currentDetail = t;
  state.logOffset = 0;
  $('#detail-title').textContent = t.title;
  $('#detail-modal').classList.remove('hidden');
  renderMeta();
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
      ${t.exitCode !== null ? `<dt>Exit</dt><dd>code=${esc(t.exitCode)} signal=${esc(t.exitSignal || '')}</dd>` : ''}
      ${t.failureReason ? `<dt>Failure</dt><dd class="err">${esc(t.failureReason)}</dd>` : ''}
      ${t.hitlReason ? `<dt>HITL</dt><dd>${esc(t.hitlReason)}</dd>` : ''}
      ${t.analysisPath ? `<dt>Analysis</dt><dd><a href="file://${esc(t.analysisPath)}" target="_blank">open</a></dd>` : ''}
      ${t.stage2MergePath ? `<dt>Stage 2 merge</dt><dd><a href="file://${esc(t.stage2MergePath)}" target="_blank">open</a></dd>` : ''}
    </dl>
  `;
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
