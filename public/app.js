// devteam-board frontend.
// Polls /api/tickets every 2 seconds, renders columns (8: Backlog, 4 stages,
// Awaiting HITL, Done, Failed), and the detail modal with state.md panel +
// Log / Reasoning / Tools / Events tabs and session resume.
//
// Vocab is fetched from /api/vocab on boot — pipeline status, current stage,
// per-stage status, HITL state/action all resolve through the vocab, so
// adding a new value in devTeam requires no frontend change.

const POLL_MS = 2000;

// Column layout. The awaiting_hitl column is new in v0.2 — the devTeam
// pipeline has a distinct awaiting_hitl state (paused at the analytics
// gate) that we no longer fold into "running".
const COLUMN_IDS = [
  'backlog', 'analytics', 'development', 'testing', 'admin',
  'awaiting_hitl', 'completed', 'failed',
];

const COLUMN_LABELS = {
  backlog: 'Backlog',
  analytics: 'Analytics',
  development: 'Development',
  testing: 'Testing',
  admin: 'Admin',
  awaiting_hitl: 'Awaiting HITL',
  completed: 'Done',
  failed: 'Failed',
};

const state = {
  tickets: [],
  currentDetail: null,
  logOffset: 0,
  logTimer: null,
  activeTab: 'log',
  vocab: null,  // populated by fetchVocab() on boot
  logFilter: 'all',  // current filter on the Log tab
  logAutoScroll: true,
  // Cached raw entries for the current ticket (for Copy / Download).
  logEntries: [],
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- Vocab helpers -------------------------------------------------------

async function fetchVocab() {
  try {
    const r = await fetch('/api/vocab');
    if (r.ok) state.vocab = await r.json();
  } catch { /* leave null — fall back to hardcoded labels */ }
  if (!state.vocab) {
    // Fallback so the UI still works if /api/vocab is unavailable.
    state.vocab = {
      pipelineStatus: [
        { id: 'pending', label: 'Pending', token: 'muted', order: 0 },
        { id: 'in_progress', label: 'Running', token: 'info', order: 1 },
        { id: 'awaiting_hitl', label: 'Awaiting HITL', token: 'warning', order: 2 },
        { id: 'completed', label: 'Completed', token: 'success', order: 3 },
        { id: 'failed', label: 'Failed', token: 'danger', order: 4 },
        { id: 'aborted', label: 'Aborted', token: 'danger', order: 5 },
      ],
      currentStage: [
        { id: 'analytics', label: 'Analytics', token: 'stage-analytics', order: 1 },
        { id: 'development', label: 'Development', token: 'stage-development', order: 2 },
        { id: 'testing', label: 'Testing', token: 'stage-testing', order: 3 },
        { id: 'admin', label: 'Admin', token: 'stage-admin', order: 4 },
      ],
      stageStatus: [
        { id: 'pending', label: 'Pending', token: 'muted', order: 0 },
        { id: 'in_progress', label: 'Running', token: 'info', order: 1 },
        { id: 'completed', label: 'Completed', token: 'success', order: 2 },
        { id: 'failed', label: 'Failed', token: 'danger', order: 3 },
        { id: 'skipped', label: 'Skipped', token: 'muted', order: 4 },
      ],
      hitlAction: [
        { id: 'none', label: '—', token: 'muted', order: 0 },
        { id: 'approve', label: 'Approve', token: 'success', order: 1 },
        { id: 'edit', label: 'Edit', token: 'info', order: 2 },
        { id: 'request_changes', label: 'Request changes', token: 'warning', order: 3 },
        { id: 'abort', label: 'Abort', token: 'danger', order: 4 },
      ],
      stageIds: ['analytics', 'development', 'testing', 'admin'],
    };
  }
}

function vocabEntry(list, id) {
  if (!state.vocab || !id) return null;
  const arr = state.vocab[list];
  if (!Array.isArray(arr)) return null;
  return arr.find((e) => e.id === id) || null;
}

function tokenClass(token) {
  // Map a vocab token to a CSS class. Tokens that don't match fall through
  // to a neutral muted class.
  if (!token) return 'token-muted';
  if (/^(muted|info|warning|success|danger)$/.test(token)) return `token-${token}`;
  return 'token-muted';
}

function pipelineLabel(id) {
  return vocabEntry('pipelineStatus', id)?.label || (id || '—');
}

function stageLabel(id) {
  return vocabEntry('currentStage', id)?.label || (id || '—');
}

function stageStatusLabel(id) {
  return vocabEntry('stageStatus', id)?.label || (id || '—');
}

function hitlActionLabel(id) {
  return vocabEntry('hitlAction', id)?.label || (id || '—');
}

function hitlActionIcon(id) {
  switch (id) {
    case 'approve': return '✓';
    case 'edit': return '✎';
    case 'request_changes': return '↻';
    case 'abort': return '✕';
    default: return '·';
  }
}

// --- Column resolution ----------------------------------------------------

/**
 * Map a ticket to its column. Authoritative priority:
 *   1. pipelineStatus=awaiting_hitl → "awaiting_hitl" (a paused pipeline is
 *      semantically distinct from a running one — needs human input).
 *   2. status=running AND currentStage in [analytics|development|testing|admin]
 *      → that stage column.
 *   3. status=awaiting_approval (legacy) → awaiting_hitl.
 *   4. status=cancelled OR pipelineStatus=aborted → "failed" (terminal
 *      failures share a column in v0.2; aborted is its own pipelineStatus
 *      but we surface it under Failed so the user sees the negative
 *      outcome — the modal still shows the precise pipelineStatus).
 *   5. status in [completed, failed] → that column.
 *   6. otherwise → "backlog".
 */
function columnFor(t) {
  if (t.pipelineStatus === 'awaiting_hitl' || t.status === 'awaiting_approval') {
    return 'awaiting_hitl';
  }
  if (t.status === 'running') {
    return t.stage && COLUMN_IDS.includes(t.stage) ? t.stage : 'analytics';
  }
  if (t.status === 'cancelled' || t.pipelineStatus === 'aborted') return 'failed';
  if (t.status === 'completed') return 'completed';
  if (t.status === 'failed') return 'failed';
  return 'backlog';
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
  const groups = Object.fromEntries(COLUMN_IDS.map((id) => [id, []]));
  for (const t of state.tickets) {
    const col = columnFor(t);
    if (groups[col]) groups[col].push(t);
  }
  for (const id of COLUMN_IDS) {
    const cardsEl = document.getElementById(colCardsId(id));
    if (!cardsEl) continue;
    cardsEl.innerHTML = '';
    for (const t of groups[id]) cardsEl.appendChild(cardEl(t));
  }
}

function colCardsId(colId) {
  // All columns use id `col-<id>` for the cards div except awaiting_hitl,
  // which is `col-awaiting_hitl-cards` (we reuse the column's id for the
  // header). This helper keeps the lookup in one place.
  if (colId === 'awaiting_hitl') return 'col-awaiting_hitl-cards';
  return `col-${colId}`;
}

function cardEl(t) {
  const el = document.createElement('div');
  const status = t.pipelineStatus && t.pipelineStatus !== 'in_progress' && t.pipelineStatus !== 'pending'
    ? t.pipelineStatus
    : t.status;
  el.className = `card status-${status}`;
  el.dataset.id = t.id;
  const age = t.lastActivityAt ? humanAge(Date.now() - t.lastActivityAt) : '';
  const psEntry = vocabEntry('pipelineStatus', t.pipelineStatus);
  const psLabel = psEntry ? psEntry.label : null;
  const psToken = psEntry ? psEntry.token : null;
  const hitlAction = t.hitlAction;
  const showHitlAction = hitlAction && hitlAction !== 'none';
  const showPipelineBadge = t.pipelineStatus && t.pipelineStatus !== t.status
    && !(t.pipelineStatus === 'in_progress' && t.status === 'running');
  el.innerHTML = `
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-sub">
      <code class="branch">${esc(t.branch)}</code>
      ${t.substage ? `<span class="substage">${esc(t.substage)}</span>` : ''}
      ${showPipelineBadge ? `<span class="pipeline-badge ${tokenClass(psToken)}"><span class="dot"></span>${esc(psLabel)}</span>` : ''}
      ${showHitlAction ? `<span class="hitl-action action-${esc(hitlAction)}" title="HITL action: ${esc(hitlActionLabel(hitlAction))}">${hitlActionIcon(hitlAction)} ${esc(hitlActionLabel(hitlAction))}</span>` : ''}
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

// --- Mode + stages toggle ------------------------------------------------
// The new-ticket form has a Mode radio (devteam | simple) and four
// stage checkboxes. In simple mode the stages section is hidden — the
// prompt goes straight to qwen with no /devteam:build wrapping.

function syncModeSections() {
  const mode = document.querySelector('input[name="mode"]:checked');
  const stagesSection = document.getElementById('stages-section');
  if (!mode || !stagesSection) return;
  stagesSection.classList.toggle('hidden', mode.value !== 'devteam');
}

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', syncModeSections);
});
syncModeSections();

// --- Workdir → base branch dropdown --------------------------------------
// The base branch is a native <select>, always enabled — it has at
// least a "select a workdir first" placeholder. Once a workdir is
// typed, /api/branches populates the list with that repo's local
// branches. The default selection is "main" if present, else the
// first branch. For branches that don't exist locally (tags, remote
// refs), the user can type the name in the separate "Branch name"
// field — that's the feature-branch name, not the base.

const workdirInputEl = document.querySelector('#new-ticket-form input[name="workdir"]');
const baseSelectEl = document.getElementById('base-branches');
const baseHintEl = document.getElementById('base-hint');

let workdirDebounce = null;
let workdirLastFetched = null;
let workdirAbortCtl = null;

function renderBasePlaceholder(hint) {
  if (!baseSelectEl) return;
  baseSelectEl.innerHTML = '<option value="" disabled selected>select a workdir first</option>';
  if (baseHintEl) baseHintEl.textContent = hint || '—';
}

function renderBaseBranches(branches, prevSelection) {
  if (!baseSelectEl) return;
  if (!branches || branches.length === 0) {
    renderBasePlaceholder('no local branches — type one in Branch name below');
    return;
  }
  const opts = branches.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  baseSelectEl.innerHTML = opts;
  // Re-select: prefer the previous selection if it's still in the list;
  // otherwise default to "main" if present, else the first branch.
  let chosen = null;
  if (prevSelection && branches.includes(prevSelection)) chosen = prevSelection;
  if (!chosen && branches.includes('main')) chosen = 'main';
  if (!chosen) chosen = branches[0];
  baseSelectEl.value = chosen;
  if (baseHintEl) baseHintEl.textContent = `${branches.length} local branch${branches.length === 1 ? '' : 'es'}`;
}

async function refreshBranchesFor(workdir) {
  const path = (workdir || '').trim();
  const prevSelection = baseSelectEl ? baseSelectEl.value : null;
  if (!path) {
    renderBasePlaceholder('select a repo path first');
    return;
  }
  if (workdirAbortCtl) workdirAbortCtl.abort();
  workdirAbortCtl = new AbortController();
  workdirLastFetched = path;
  if (baseHintEl) baseHintEl.textContent = 'loading branches…';
  try {
    const r = await fetch(`/api/branches?path=${encodeURIComponent(path)}`, {
      signal: workdirAbortCtl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (workdirLastFetched !== path) return; // stale
    renderBaseBranches(data.branches || [], prevSelection);
  } catch (e) {
    if (e.name === 'AbortError') return;
    renderBasePlaceholder('could not list branches (not a git repo?)');
  }
}

if (workdirInputEl) {
  workdirInputEl.addEventListener('input', () => {
    if (workdirDebounce) clearTimeout(workdirDebounce);
    workdirDebounce = setTimeout(() => refreshBranchesFor(workdirInputEl.value), 200);
  });
  workdirInputEl.addEventListener('change', () => refreshBranchesFor(workdirInputEl.value));
}

$('#new-ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const mode = fd.get('mode') || 'devteam';
  const baseVal = fd.get('base');
  if (mode === 'devteam' && !baseVal) {
    alert('Pick a base branch first.');
    return;
  }
  // In devteam mode, gather the selected stage checkboxes; in simple
  // mode, stages are null (the buildPrompt will ignore them).
  const stages = mode === 'devteam' ? fd.getAll('stage') : null;
  const body = {
    title: fd.get('title'),
    workdir: fd.get('workdir'),
    base: baseVal || 'main',
    branch: fd.get('branch') || undefined,
    noNewBranch: fd.get('noNewBranch') === 'on',
    mode,
    stages,
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
  syncModeSections();
  renderBasePlaceholder('select a repo path first');
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
  state.logEntries = [];
  const logEl = $('#logs');
  if (logEl) logEl.innerHTML = '';
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
  state.logEntries = [];
  // Reset the log DOM container (we no longer use a <pre>).
  const logEl = $('#logs');
  if (logEl) logEl.innerHTML = '';
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
  // Legacy stage pills (kept for visual continuity — actual per-stage
  // statuses live in renderStatePanel from state.md).
  const stages = ['analytics', 'development', 'testing', 'admin'].map((s) => {
    const done = (t.stagesCompleted || []).includes(s);
    const cur = t.stage === s;
    return `<span class="stage-pill ${done ? 'done' : ''} ${cur ? 'cur' : ''}">${s}</span>`;
  }).join(' → ');

  // Pipeline status badge (authoritative from state.md when bound).
  const psEntry = vocabEntry('pipelineStatus', t.pipelineStatus);
  const psToken = psEntry ? psEntry.token : null;
  const psBadge = t.pipelineStatus
    ? `<span class="pipeline-badge ${tokenClass(psToken)}"><span class="dot"></span>${esc(pipelineLabel(t.pipelineStatus))}</span>`
    : `<span class="muted">—</span>`;

  // HITL action badge.
  const hitlAction = t.hitlAction;
  const hitlActionEl = (hitlAction && hitlAction !== 'none')
    ? `<span class="hitl-action action-${esc(hitlAction)}">${hitlActionIcon(hitlAction)} ${esc(hitlActionLabel(hitlAction))}</span>`
    : `<span class="muted">—</span>`;

  // Bound-to-state.md marker.
  const stateBoundBadge = t.planIdBoundAt
    ? '<span class="badge status-completed" title="Bound to devTeam state.md (authoritative)">⛓</span>'
    : '';

  $('#detail-meta').innerHTML = `
    <dl>
      <dt>ID</dt><dd><code>${esc(t.id)}</code></dd>
      <dt>Status</dt><dd><span class="badge status-${t.status}">${esc(t.status)}</span> ${stateBoundBadge}</dd>
      <dt>Pipeline</dt><dd>${psBadge}</dd>
      <dt>HITL</dt><dd>${hitlActionEl}</dd>
      <dt>Stage</dt><dd>${stages}</dd>
      <dt>Substage</dt><dd>${esc(t.substage || '—')}</dd>
      <dt>Branch</dt><dd><code>${esc(t.branch)}</code></dd>
      <dt>Plan ID</dt><dd><code>${esc(t.planId)}</code>${t.planIdBoundAt ? ` <span class="muted">(bound)</span>` : ''}</dd>
      <dt>Worktree</dt><dd><code class="path">${esc(t.worktreePath)}</code></dd>
      <dt>qwen PID</dt><dd>${t.qwenPid ?? '—'}</dd>
      ${t.stateCreated ? `<dt>State created</dt><dd><code>${esc(t.stateCreated)}</code></dd>` : ''}
      ${t.stateUpdated ? `<dt>State updated</dt><dd><code>${esc(t.stateUpdated)}</code></dd>` : ''}
      ${t.lastStateEvent ? `<dt>Last event</dt><dd class="muted" style="font-size:11px">${esc(t.lastStateEvent)}</dd>` : ''}
      ${t.exitCode !== null && t.exitCode !== undefined ? `<dt>Exit</dt><dd>code=${esc(t.exitCode)} signal=${esc(t.exitSignal || '')}</dd>` : ''}
      ${t.failureReason ? `<dt>Failure</dt><dd class="err">${esc(t.failureReason)}</dd>` : ''}
      ${t.hitlReason ? `<dt>HITL reason</dt><dd>${esc(t.hitlReason)}</dd>` : ''}
      ${t.sessionId ? `<dt>Session</dt><dd><code class="path" title="qwen session id (for --resume)">${esc(t.sessionId.slice(0, 16))}…</code></dd>` : ''}
      ${t.analysisPath ? `<dt>Analysis</dt><dd><a href="file://${esc(t.analysisPath)}" target="_blank">open</a></dd>` : ''}
      ${t.stage2MergePath ? `<dt>Stage 2 merge</dt><dd><a href="file://${esc(t.stage2MergePath)}" target="_blank">open</a></dd>` : ''}
      ${t.hitlPath ? `<dt>HITL log</dt><dd><a href="file://${esc(t.hitlPath)}" target="_blank">open</a></dd>` : ''}
      ${(t.reviewFiles && t.reviewFiles.length) ? `<dt>Review files</dt><dd>${t.reviewFiles.map((p) => `<a href="file://${esc(p)}" target="_blank">${esc(p.split('/').pop())}</a>`).join('<br>')}</dd>` : ''}
    </dl>
  `;
  renderStatePanel();
}

function renderStatePanel() {
  const t = state.currentDetail;
  const el = $('#detail-state');
  if (!el) return;
  if (!t) { el.innerHTML = ''; return; }

  // Per-stage pills: one per stage, with status from state.md.
  // The backend now passes the raw `t.stages` object (e.g. { analytics:
  // 'completed', development: 'in_progress', testing: 'pending', admin:
  // 'skipped' }); if it's missing (older tickets / before state-bind) we
  // fall back to reconstructing from stagesCompleted + stagesSkipped +
  // currentStage.
  const stageIds = (state.vocab && state.vocab.stageIds) || ['analytics', 'development', 'testing', 'admin'];
  const stageStatuses = {};
  for (const id of stageIds) {
    if (t.stages && t.stages[id]) {
      stageStatuses[id] = t.stages[id];
    } else if ((t.stagesSkipped || []).includes(id)) {
      stageStatuses[id] = 'skipped';
    } else if ((t.stagesCompleted || []).includes(id)) {
      stageStatuses[id] = 'completed';
    } else if (t.currentStage === id) {
      stageStatuses[id] = 'in_progress';
    } else {
      stageStatuses[id] = 'pending';
    }
  }
  const pills = stageIds.map((id) => {
    const st = stageStatuses[id];
    const label = stageStatusLabel(st);
    const stageColorClass = `stage-color-${id}`;
    return `<span class="stage-pill-v2 status-${st} ${stageColorClass}" title="${esc(stageLabel(id))}: ${esc(label)}">
      <span class="stage-name">${esc(stageLabel(id))}</span>
      <span class="muted">·</span>
      <span>${esc(label)}</span>
    </span>`;
  }).join('');

  // Pipeline status + last event from state.md.
  const psEntry = vocabEntry('pipelineStatus', t.pipelineStatus);
  const psToken = psEntry ? psEntry.token : null;
  const psBadge = t.pipelineStatus
    ? `<span class="pipeline-badge ${tokenClass(psToken)}"><span class="dot"></span>${esc(pipelineLabel(t.pipelineStatus))}</span>`
    : '<span class="muted">no state.md yet</span>';

  el.innerHTML = `
    <div class="state-panel-row">
      <span class="label">Pipeline</span>${psBadge}
    </div>
    <div class="state-panel-row">
      <span class="label">Stages</span>${pills}
    </div>
    ${t.lastStateEvent ? `<div class="state-panel-row"><span class="label">Last</span><span class="muted" style="font-size:11px">${esc(t.lastStateEvent)}</span></div>` : ''}
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

// --- Log rendering --------------------------------------------------------

const LOG_ICON = {
  stage_started:    '▶',
  stage_completed:  '✓',
  substage:         '↪',
  hitl_paused:      '⏸',
  task_complete:    '✓',
  result:           '📊',
  system:           '⚙',
  exit:             '■',
  thinking:         '✎',
  text:             '💬',
  tool_call:        '◆',
  tool_result:      '◀',
  log:              '·',
};

const LOG_CATEGORY = {
  stage_started:    'stage',
  stage_completed:  'stage',
  substage:         'stage',
  hitl_paused:      'stage',
  task_complete:    'stage',
  result:           'stage',
  system:           'stage',
  exit:             'stage',
  thinking:         'thinking',
  text:             'text',
  tool_call:        'tool',
  tool_result:      'tool',
  log:              'log',
};

function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  // HH:MM:SS.mmm — local time, easier to correlate with the user's wall clock.
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function renderLogEntry(e) {
  const ts = fmtTs(e.ts);
  const icon = LOG_ICON[e.kind] || '·';
  const cat = LOG_CATEGORY[e.kind] || 'log';
  const errClass = (e.is_error || e.kind === 'exit' && e.code !== 0 || e.source === 'stderr') ? ' log-err' : '';
  const header = `<span class="log-ts">${ts}</span><span class="log-icon" aria-hidden="true">${icon}</span><span class="log-body">`;
  let body = '';
  switch (e.kind) {
    case 'tool_call': {
      const inputStr = e.input ? JSON.stringify(e.input, null, 2) : '{}';
      const stageBadge = e.stage ? `<span class="stage-badge stage-${esc(e.stage.id || e.stage)}">${esc(e.stage.label || e.stage)}</span>` : '';
      body = `<b>${esc(e.name || 'tool')}</b> ${stageBadge}` +
        `<details class="log-details"><summary>input</summary><pre>${esc(inputStr)}</pre></details>`;
      break;
    }
    case 'tool_result': {
      const content = e.content == null ? '' : String(e.content);
      const preview = content.length > 240 ? content.slice(0, 240) + '…' : content;
      body = `${e.is_error ? '<span class="err">error</span> · ' : ''}<span class="muted">${esc(preview)}</span>` +
        (content.length > 240 ? `<details class="log-details"><summary>full output (${content.length} chars)</summary><pre>${esc(content)}</pre></details>` : '');
      break;
    }
    case 'thinking': {
      const text = e.text || '';
      body = `<span class="muted"><i>${esc(text)}</i></span>`;
      break;
    }
    case 'text': {
      const text = e.text || '';
      body = esc(text);
      break;
    }
    case 'stage_started': {
      body = `stage <b>${esc(e.stage || '?')}</b> started`;
      break;
    }
    case 'stage_completed': {
      const ok = e.ok !== false;
      body = `stage <b>${esc(e.stage || '?')}</b> ${ok ? 'completed' : '<span class="err">failed</span>'}`;
      break;
    }
    case 'substage': {
      body = `<span class="muted">${esc((e.groups || []).join(' › ') || '—')}</span>`;
      break;
    }
    case 'hitl_paused': {
      body = `HITL paused${e.groups && e.groups[0] ? ': <b>' + esc(e.groups[0]) + '</b>' : ''}`;
      break;
    }
    case 'task_complete': {
      body = `task complete`;
      break;
    }
    case 'result': {
      const dur = typeof e.durationMs === 'number' ? (e.durationMs / 1000).toFixed(1) + 's' : '?s';
      const turns = e.numTurns ?? '?';
      const ok = e.ok !== false;
      body = `result: ${ok ? 'ok' : '<span class="err">error</span>'} · ${turns} turns · ${dur}` +
        (e.summary ? `<details class="log-details"><summary>summary</summary><pre>${esc(e.summary)}</pre></details>` : '');
      break;
    }
    case 'system': {
      const sid = e.sessionId ? ' · session ' + esc(e.sessionId.slice(0, 8)) : '';
      body = `<span class="muted">${esc(e.subtype || 'system')}${sid}</span>`;
      break;
    }
    case 'exit': {
      const ok = e.code === 0;
      body = `exit code=${e.code}${e.signal ? ' signal=' + esc(e.signal) : ''}`;
      // The "ok" suffix flips the entry to log-err via errClass.
      void ok;
      break;
    }
    case 'log':
    default: {
      const text = e.text || '';
      body = esc(text);
      break;
    }
  }
  return `<div class="log-line log-kind-${e.kind} log-cat-${cat}${errClass}" data-kind="${e.kind}" data-cat="${cat}">${header}${body}</span></div>`;
}

function entryToText(e) {
  // Plain-text fallback for Copy / Download.
  const ts = fmtTs(e.ts);
  const icon = LOG_ICON[e.kind] || '·';
  let body = '';
  switch (e.kind) {
    case 'tool_call': body = `${e.name || 'tool'} ${JSON.stringify(e.input || {})}`;
      break;
    case 'tool_result': body = e.is_error ? `error: ${e.content || ''}` : String(e.content || '');
      break;
    case 'thinking': body = e.text || '';
      break;
    case 'text': body = e.text || '';
      break;
    case 'stage_started': body = `stage ${e.stage} started`;
      break;
    case 'stage_completed': body = `stage ${e.stage} ${e.ok !== false ? 'completed' : 'failed'}`;
      break;
    case 'substage': body = (e.groups || []).join(' › ');
      break;
    case 'hitl_paused': body = `HITL paused${e.groups && e.groups[0] ? ': ' + e.groups[0] : ''}`;
      break;
    case 'task_complete': body = 'task complete';
      break;
    case 'result': body = `result: ${e.ok !== false ? 'ok' : 'error'} · ${e.numTurns ?? '?'} turns · ${(e.durationMs || 0) / 1000}s`;
      break;
    case 'system': body = `system: ${e.subtype || ''}${e.sessionId ? ' session=' + e.sessionId : ''}`;
      break;
    case 'exit': body = `exit code=${e.code}${e.signal ? ' signal=' + e.signal : ''}`;
      break;
    default: body = e.text || JSON.stringify(e);
  }
  return `${ts} ${icon} ${body}`;
}

function applyLogFilter() {
  const cat = state.logFilter;
  const lines = document.querySelectorAll('#logs .log-line');
  let visible = 0;
  for (const el of lines) {
    const lineCat = el.dataset.cat;
    const isErr = el.classList.contains('log-err');
    let show = false;
    if (cat === 'all') show = true;
    else if (cat === 'err') show = isErr;
    else show = lineCat === cat;
    el.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  $('#logs-status').textContent = `${visible}/${lines.length}`;
}

async function pollLogs() {
  if (!state.currentDetail) return;
  const id = state.currentDetail.id;
  const r = await fetch(`/api/tickets/${id}/logs?since=${state.logOffset}`);
  if (!r.ok) return;
  const { entries, total } = await r.json();
  if (entries && entries.length) {
    state.logEntries = state.logEntries.concat(entries);
    const logEl = $('#logs');
    const frag = document.createDocumentFragment();
    const tmp = document.createElement('div');
    tmp.innerHTML = entries.map(renderLogEntry).join('');
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    logEl.appendChild(frag);
    applyLogFilter();
    if (state.logAutoScroll) logEl.scrollTop = logEl.scrollHeight;
  }
  state.logOffset = total;
  if (!entries || !entries.length) {
    $('#logs-status').textContent = `${total} total`;
  }
}

// --- Log toolbar wiring --------------------------------------------------

document.querySelectorAll('#log-filters .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.logFilter = btn.dataset.filter;
    document.querySelectorAll('#log-filters .filter-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    applyLogFilter();
  });
});

const autoScrollEl = document.getElementById('log-auto-scroll');
if (autoScrollEl) autoScrollEl.addEventListener('change', () => {
  state.logAutoScroll = autoScrollEl.checked;
});

const btnCopyLogs = document.getElementById('btn-copy-logs');
if (btnCopyLogs) btnCopyLogs.addEventListener('click', async () => {
  const text = state.logEntries.map(entryToText).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    btnCopyLogs.textContent = 'Copied ✓';
    setTimeout(() => { btnCopyLogs.textContent = 'Copy'; }, 1500);
  } catch (e) {
    alert('Copy failed: ' + (e.message || e));
  }
});

const btnDownloadLogs = document.getElementById('btn-download-logs');
if (btnDownloadLogs) btnDownloadLogs.addEventListener('click', () => {
  const text = state.logEntries.map(entryToText).join('\n');
  const id = state.currentDetail ? state.currentDetail.id : 'ticket';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${id}.log`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
});

// --- Boot -----------------------------------------------------------------

(async () => {
  await fetchVocab();
  setInterval(fetchBoard, POLL_MS);
  fetchBoard();
})();
