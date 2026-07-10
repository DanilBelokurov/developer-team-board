#!/usr/bin/env node
// devteam-board entrypoint. Single Node.js process that:
//   - manages ticket state in lowdb (board.json)
//   - creates git worktrees per ticket
//   - spawns `qwen -p "/devteam:build ..."` per ticket and supervises the subprocess
//   - reads .devteam/plans/<id>/state.md (authoritative pipeline state)
//   - parses stream-json events from qwen-cli stdout (enrichment: substage,
//     tool_calls, thinking, logs)
//   - serves a REST API + static UI on PORT
//
// Cross-process contracts with devteam, in priority order:
//   (a) .devteam/plans/<id>/state.md         (authoritative — Pipeline
//                                              status / Current stage /
//                                              per-stage rows / HITL)
//   (b) .devteam/plans/<id>/{analysis.md,
//                            stage2.merge.md,
//                            hitl.md,
//                            plans/NN-review-N.md}  (artifacts for the UI)
//   (c) stream-json stdout events            (enrichment: substage,
//                                              thinking, tool calls, logs)
//   (d) git worktree state                   (isolation)
//
// state.md wins over (c) whenever they disagree. Stream-json can set
// substage / lastActivityAt, but it cannot change status / stage.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initDb, getDb, getTicket, upsertTicket, patchTicket, deleteTicket, listTickets } from './db.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { startPipeline, getLogs, cancelPipeline } from './pipeline.js';
import { writeHitlResponse } from './hitl.js';
import { listProjects, getProjectsRoot, listBranches } from './projects.js';
import { createStateWatcher, discoverPlanDirs } from './state-watcher.js';
import { stateToBoardState, parseStateMd } from './state-parser.js';
import { exportVocab, isTerminal, STAGE_IDS, lookup as vocabLookup, PIPELINE_STATUS, STAGE_STATUS, HITL_ACTION } from './state-vocab.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BOARD_FILE = process.env.BOARD_FILE || join(__dirname, '..', 'board.json');

const STAGES = ['analytics', 'development', 'testing', 'admin'];

// --- State transitions ----------------------------------------------------

/**
 * Apply a StateSnapshot from state.md to the ticket. This is the
 * authoritative path: any value that comes from state.md wins over
 * stream-json. Returns true if any board-visible field changed.
 *
 * @param {object} ticket
 * @param {import('./state-parser.js').StateSnapshot} snap
 */
function applyStateSnapshot(ticket, snap) {
  if (!snap) return false;
  const now = Date.now();
  const before = {
    status: ticket.status,
    stage: ticket.stage,
    stagesCompleted: ticket.stagesCompleted,
    stagesSkipped: ticket.stagesSkipped,
    pipelineStatus: ticket.pipelineStatus,
    hitlAction: ticket.hitlAction,
    hitlState: ticket.hitlState,
    planId: ticket.planId,
    feature: ticket.feature,
  };

  const board = stateToBoardState(snap);
  ticket.pipelineStatus = snap.pipelineStatus;
  ticket.currentStage = snap.currentStage;
  ticket.hitlState = snap.hitlState;
  ticket.hitlAction = snap.hitlAction;
  ticket.stagesCompleted = board.stagesCompleted;
  ticket.stagesSkipped = board.stagesSkipped;
  // Raw per-stage status from state.md — lets the UI render per-stage
  // pills with full fidelity (pending/in_progress/failed/skipped/completed),
  // not just the collapsed completed/skipped arrays.
  ticket.stages = { ...snap.stages };
  ticket.status = board.status;
  ticket.stage = board.stage;
  ticket.lastActivityAt = now;

  // Bind / refresh the canonical planId. We only switch planId away from
  // the legacy `plan-<ts>-<uuid>` once; after that, we trust state.md.
  if (snap.planId && snap.planId !== ticket.planId) {
    if (!ticket.planIdBoundAt || ticket.planId.startsWith('plan-')) {
      ticket.planId = snap.planId;
      ticket.planIdBoundAt = now;
    }
  }
  if (snap.feature && (!ticket.feature || ticket.feature !== snap.feature)) {
    ticket.feature = snap.feature;
  }
  if (snap.created) ticket.stateCreated = snap.created;
  if (snap.updated) ticket.stateUpdated = snap.updated;
  if (snap.lastEvent) ticket.lastStateEvent = snap.lastEvent;

  const after = {
    status: ticket.status,
    stage: ticket.stage,
    stagesCompleted: ticket.stagesCompleted,
    stagesSkipped: ticket.stagesSkipped,
    pipelineStatus: ticket.pipelineStatus,
    hitlAction: ticket.hitlAction,
    hitlState: ticket.hitlState,
    planId: ticket.planId,
    feature: ticket.feature,
  };
  return !shallowEqual(before, after);
}

function shallowEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (Array.isArray(a[k]) || Array.isArray(b[k])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Apply a stream-json event. This is the enrichment path: substage,
 * lastActivityAt, toolCalls, thinking, sessionId, usage, etc.
 *
 * Status / stage / stagesCompleted are NOT modified here once state.md
 * has bound a real planId — that is the priority rule. Before binding,
 * we fall back to event-driven transitions so the UI is alive while
 * waiting for state.md to appear.
 */
function applyEvent(ticket, emit) {
  const now = Date.now();
  const kind = emit.kind || emit.type;
  const stateBound = !!(ticket.planIdBoundAt || (ticket.planId && !ticket.planId.startsWith('plan-')));

  switch (kind) {
    case 'stage_started':
      ticket.lastActivityAt = now;
      if (stateBound) {
        // state.md will own the status; we only update substage and timestamp.
        if (emit.stage) ticket.substage = emit.stage;
        return true;
      }
      ticket.stage = emit.stage;
      ticket.substage = null;
      ticket.status = 'running';
      return true;
    case 'stage_completed':
      ticket.lastActivityAt = now;
      if (stateBound) return true;
      ticket.stage = emit.stage;
      ticket.stagesCompleted = Array.from(new Set([...(ticket.stagesCompleted || []), emit.stage]));
      const idx = STAGES.indexOf(emit.stage);
      if (idx === STAGES.length - 1) {
        ticket.status = 'completed';
        ticket.finishedAt = now;
      } else {
        ticket.substage = null;
      }
      return true;
    case 'stage_failed':
      ticket.lastActivityAt = now;
      if (stateBound) {
        ticket.failureReason = `${emit.stage}: ${emit.raw}`;
        return true;
      }
      ticket.status = 'failed';
      ticket.failureReason = `${emit.stage}: ${emit.raw}`;
      ticket.finishedAt = now;
      return true;
    case 'substage':
      ticket.substage = emit.groups?.[0] || ticket.substage;
      ticket.lastActivityAt = now;
      return true;
    case 'task_complete':
      ticket.lastActivityAt = now;
      if (stateBound) return true;
      ticket.status = 'completed';
      ticket.finishedAt = now;
      return true;
    case 'exit':
      ticket.exitCode = emit.code;
      ticket.exitSignal = emit.signal;
      ticket.lastActivityAt = now;
      // If state.md has not bound yet, treat exit as terminal.
      if (!stateBound && (ticket.status === 'running' || ticket.status === 'awaiting_approval' || ticket.status === 'backlog')) {
        ticket.status = emit.code === 0 ? 'completed' : 'failed';
        ticket.finishedAt = now;
      }
      return true;
    case 'hitl_paused':
      ticket.lastActivityAt = now;
      ticket.hitlReason = emit.groups?.[0] || emit.raw;
      if (stateBound) return true;
      ticket.status = 'awaiting_approval';
      return true;
  }
  return false;
}

const onEvent = (planId, ticketId, emit) => {
  const t = getTicket(ticketId);
  if (!t) return;
  const kind = emit.kind || emit.type;

  // Side-channel accumulators (independent of state machine).
  if (kind === 'tool_call') {
    t.toolCalls = (t.toolCalls || []).concat([{
      at: Date.now(),
      id: emit.id,
      name: emit.name,
      input: emit.input || {},
      stage: emit.stage,
      output: null,
      isError: false,
    }]).slice(-200);
  } else if (kind === 'tool_result') {
    const calls = t.toolCalls || [];
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].id && calls[i].id === emit.tool_use_id) {
        calls[i].output = emit.content;
        calls[i].isError = !!emit.is_error;
        calls[i].finishedAt = Date.now();
        break;
      }
    }
    t.toolCalls = calls;
  } else if (kind === 'thinking') {
    t.thinking = (t.thinking || []).concat([{ at: Date.now(), text: (emit.text || '').slice(0, 4096) }]).slice(-80);
  } else if (kind === 'system' && emit.subtype === 'init' && emit.sessionId) {
    t.sessionId = emit.sessionId;
  } else if (kind === 'result') {
    t.usage = emit.usage || null;
    t.numTurns = emit.numTurns;
    t.durationMs = emit.durationMs;
    t.apiDurationMs = emit.apiDurationMs;
    t.resultSummary = emit.summary || null;
    t.resultError = emit.error || null;
  }

  const changed = applyEvent(t, emit);
  t.events = (t.events || []).concat([{ at: Date.now(), ...emit }]).slice(-300);
  if (changed) console.log(`[event] ${ticketId} -> ${kind} ${emit.stage || ''} ${emit.groups?.[0] || ''}`.trim());
  upsertTicket(t);
};

const onExit = (ticketId, code, signal) => {
  const t = getTicket(ticketId);
  if (!t) return;
  // Only treat exit as terminal if no state.md is bound.
  const stateBound = !!(t.planIdBoundAt || (t.planId && !t.planId.startsWith('plan-')));
  if (!stateBound && t.status === 'running') {
    t.status = code === 0 ? 'completed' : 'failed';
    t.finishedAt = Date.now();
  }
  t.exitCode = code;
  t.exitSignal = signal;
  upsertTicket(t);
};

// --- Watcher: .devteam/plans/<id>/* for state.md + artifacts --------------
//
// Replaces the legacy chokidar watcher. The new watcher:
//   1. Discovers plan dirs on attach (so resume picks up existing state.md).
//   2. Watches state.md and applies snapshots via applyStateSnapshot.
//   3. Continues to report analysis.md, stage2.merge.md, hitl.md, and
//      plans/*.md review files as artifacts.

const watchers = new Map();   // ticketId -> { close, scan, getSnapshots }
const snapshots = new Map();  // planId -> latest StateSnapshot

function pickPlanIdForTicket(ticket, planIds) {
  // If the ticket already has a bound planId (devTeam format), keep it.
  if (ticket.planId && !ticket.planId.startsWith('plan-')) {
    if (planIds.includes(ticket.planId)) return ticket.planId;
  }
  // Else prefer the one whose state.md feature matches the ticket title.
  // Fall back to the most recently created plan dir (lexicographic — fine
  // because devTeam planIds encode the timestamp suffix in the hash).
  if (planIds.length === 0) return null;
  if (planIds.length === 1) return planIds[0];
  for (const id of planIds) {
    const snap = snapshots.get(id);
    if (snap && snap.feature && ticket.title && snap.feature === ticket.title) {
      return id;
    }
  }
  return [...planIds].sort().pop();
}

function applyArtifactToTicket(ticket, planId, kind, path) {
  if (ticket.planId && ticket.planId !== planId && !ticket.planId.startsWith('plan-')) {
    // Another ticket already owns this planId — don't claim it.
    return false;
  }
  switch (kind) {
    case 'analysis':
      ticket.analysisPath = path;
      return true;
    case 'stage2_merge':
      ticket.stage2MergePath = path;
      return true;
    case 'hitl':
      ticket.hitlPath = path;
      return true;
    case 'review':
      ticket.reviewFiles = Array.from(new Set([...(ticket.reviewFiles || []), path])).slice(-20);
      return true;
  }
  return false;
}

function startWatcher(ticket) {
  if (watchers.has(ticket.id)) return;

  let watcher = null;
  let owningPlanId = ticket.planId && !ticket.planId.startsWith('plan-') ? ticket.planId : null;

  const handle = async () => {
    const t = getTicket(ticket.id);
    if (!t) return;
    const planIds = watcher ? Array.from(watcher.getPlanDirs().keys()) : [];
    if (!owningPlanId) {
      owningPlanId = pickPlanIdForTicket(t, planIds);
      if (owningPlanId) t.planId = owningPlanId;
    }
    if (owningPlanId) {
      const snap = snapshots.get(owningPlanId);
      if (snap) {
        const changed = applyStateSnapshot(t, snap);
        if (changed) {
          console.log(`[state] ${ticket.id} -> ${snap.pipelineStatus} / ${snap.currentStage} / hitlAction=${snap.hitlAction}`);
        }
      }
    }
    upsertTicket(t);
  };

  watcher = createStateWatcher({
    worktreePath: ticket.worktreePath,
    onSnapshot: (evt) => {
      snapshots.set(evt.planId, evt.snapshot);
      // Only act if this planId is the one we own (or none yet).
      if (!owningPlanId || owningPlanId === evt.planId) {
        handle();
      }
    },
    onPlanDiscovered: (evt) => {
      // When a new plan dir shows up, re-evaluate ownership.
      handle();
    },
    onArtifact: (evt) => {
      const t = getTicket(ticket.id);
      if (!t) return;
      if (!owningPlanId || owningPlanId === evt.planId) {
        if (applyArtifactToTicket(t, evt.planId, evt.file, evt.path)) {
          upsertTicket(t);
        }
      }
    },
  });
  watchers.set(ticket.id, watcher);

  // Initial scan — picks up state.md that existed before the watcher
  // started (e.g. on board restart with in-flight tickets).
  watcher.scan().then(() => handle()).catch((e) => {
    console.warn(`[watcher] initial scan failed for ${ticket.id}: ${e.message || e}`);
  });
}

async function stopWatcher(ticketId) {
  const w = watchers.get(ticketId);
  if (!w) return;
  watchers.delete(ticketId);
  try { await w.close(); } catch { /* ignore */ }
}

// --- HTTP API -------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true, tickets: listTickets().length }));

// DevTeam pipeline vocabulary — frontend uses this to render columns and
// badges dynamically, so adding a new state value in devTeam doesn't
// require frontend changes.
app.get('/api/vocab', (_req, res) => res.json(exportVocab()));

app.get('/api/projects', async (_req, res) => {
  res.json(await listProjects());
});

// List local branches for a given repo path. Path is taken as a
// query string because it can contain slashes and absolute roots.
app.get('/api/branches', async (req, res) => {
  const repoPath = String(req.query.path || '').trim();
  if (!repoPath) return res.status(400).json({ error: 'path required' });
  const branches = await listBranches(repoPath);
  res.json({ path: repoPath, branches });
});

app.get('/api/tickets', (_req, res) => res.json(listTickets()));

app.get('/api/tickets/:id', (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json(t);
});

app.get('/api/tickets/:id/logs', (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const since = parseInt(req.query.since || '0', 10);
  const { lines, total } = getLogs(t.id, since);
  res.json({ lines, total, since: total });
});

app.post('/api/tickets', async (req, res) => {
  const { title, workdir, base = 'main', branch, noNewBranch = false, mode, stages } = req.body || {};
  if (!title || !workdir) return res.status(400).json({ error: 'title and workdir are required' });
  const id = `T-${randomUUID().slice(0, 8)}`;
  // When `noNewBranch` is true we create a detached worktree at `base` instead
  // of a fresh branch. We still need a unique worktree path per ticket, so the
  // ticket id is appended as a path suffix (the branch label is just `base`).
  const branchName = noNewBranch
    ? base
    : (branch || `devteam-board/${slugify(title)}-${id.toLowerCase()}`);
  let worktreePath;
  try {
    worktreePath = await createWorktree({
      repoPath: workdir,
      branch: branchName,
      base,
      noNewBranch,
      pathSuffix: noNewBranch ? id.toLowerCase() : null,
    });
  } catch (e) {
    return res.status(400).json({ error: 'worktree_create_failed', message: String(e.message || e) });
  }
  const planId = `plan-${Date.now()}-${randomUUID().slice(0, 6)}`;
  // Normalise mode + stages. mode defaults to 'devteam' for backwards
  // compat with tickets created before the toggle existed. stages is
  // the list of stages to RUN; buildPrompt translates to --skip-stage.
  const normMode = mode === 'simple' ? 'simple' : 'devteam';
  const normStages = normMode === 'devteam'
    ? (Array.isArray(stages) && stages.length > 0
        ? stages.filter((s) => ['analytics', 'development', 'testing', 'admin'].includes(s))
        : ['analytics', 'development', 'testing', 'admin'])
    : null;
  const ticket = {
    id,
    title,
    workdir,
    worktreePath,
    branch: branchName,
    base,
    noNewBranch,
    mode: normMode,
    stages: normStages,
    planId,
    planIdBoundAt: null,  // set when state.md binds a real devTeam planId
    status: 'backlog',
    stage: null,
    currentStage: null,
    substage: null,
    stagesCompleted: [],
    stagesSkipped: [],
    // Raw per-stage status from state.md (analytics/development/testing/admin
    // → pending|in_progress|completed|failed|skipped).
    stages: { analytics: null, development: null, testing: null, admin: null },
    // Authoritative state.md values (null until state.md is read).
    pipelineStatus: null,
    hitlState: null,
    hitlAction: null,
    stateCreated: null,
    stateUpdated: null,
    lastStateEvent: null,
    feature: null,  // mirrored from state.md (overrides title on hit)
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    qwenPid: null,
    exitCode: null,
    exitSignal: null,
    failureReason: null,
    hitlReason: null,
    analysisPath: null,
    stage2MergePath: null,
    hitlPath: null,
    reviewFiles: [],
    events: [],
    // Stream-json enrichment (filled at runtime).
    sessionId: null,
    toolCalls: [],
    thinking: [],
    usage: null,
    numTurns: null,
    durationMs: null,
    apiDurationMs: null,
    resultSummary: null,
    resultError: null,
  };
  await upsertTicket(ticket);
  startWatcher(ticket);
  // spawn qwen
  try {
    const child = startPipeline({ ticket, planId, worktreePath, onEvent, onExit });
    patchTicket(id, { qwenPid: child.pid, status: 'running' });
  } catch (e) {
    patchTicket(id, { status: 'failed', failureReason: `spawn: ${e.message || e}` });
    return res.status(500).json({ error: 'spawn_failed', message: String(e.message || e), ticket: getTicket(id) });
  }
  res.status(201).json(getTicket(id));
});

app.post('/api/tickets/:id/cancel', async (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await cancelPipeline(t.id);
  patchTicket(t.id, { status: 'cancelled', finishedAt: Date.now() });
  res.json(getTicket(t.id));
});

app.post('/api/tickets/:id/resume', async (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (!t.sessionId) return res.status(400).json({ error: 'no_session', message: 'ticket has no resumable session — only tickets started after stream-json migration can be resumed' });
  if (!t.worktreePath) return res.status(400).json({ error: 'no_worktree' });
  if (t.status === 'running') return res.status(409).json({ error: 'already_running' });
  const prompt = (req.body && typeof req.body.prompt === 'string' && req.body.prompt.trim())
    ? req.body.prompt.trim()
    : 'Continue from where we left off.';
  // Reset running state but keep ticket meta + history.
  const newPlanId = `plan-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const patch = {
    planId: newPlanId,
    status: 'running',
    stage: null,
    substage: null,
    exitCode: null,
    exitSignal: null,
    failureReason: null,
    hitlReason: null,
    events: [],
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  patchTicket(t.id, patch);
  // The legacy planId is replaced by a fresh one on resume. The watcher's
  // closure-captured owningPlanId would block state.md rebinding, so we
  // tear it down and start a new one — it will re-scan and pick up the
  // real devTeam planId once state.md appears.
  await stopWatcher(t.id);
  startWatcher(getTicket(t.id));
  try {
    const child = startPipeline({
      ticket: { ...t, title: prompt, _resumePrompt: prompt },
      planId: newPlanId,
      worktreePath: t.worktreePath,
      resumeSessionId: t.sessionId,
      onEvent,
      onExit,
    });
    patchTicket(t.id, { qwenPid: child.pid });
    res.status(202).json(getTicket(t.id));
  } catch (e) {
    patchTicket(t.id, { status: 'failed', failureReason: `resume spawn: ${e.message || e}` });
    res.status(500).json({ error: 'spawn_failed', message: String(e.message || e) });
  }
});

app.post('/api/tickets/:id/hitl', async (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const { decision, comment } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve|reject' });
  const file = await writeHitlResponse({ worktreePath: t.worktreePath, planId: t.planId, decision, comment });
  patchTicket(t.id, { hitlDecision: decision, hitlComment: comment, hitlRespondedAt: Date.now() });
  res.json({ ok: true, file });
});

app.delete('/api/tickets/:id', async (req, res) => {
  const t = getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await cancelPipeline(t.id);
  stopWatcher(t.id);
  if (t.worktreePath) {
    try { await removeWorktree({ repoPath: t.workdir, wtPath: t.worktreePath }); } catch (e) {
      console.warn(`worktree remove failed for ${t.id}: ${e.message}`);
    }
  }
  await deleteTicket(t.id);
  res.json({ ok: true });
});

// --- Startup --------------------------------------------------------------

async function main() {
  await initDb(BOARD_FILE);
  // restart watchers for any persisted tickets in non-terminal state
  for (const t of listTickets()) {
    if (!['completed', 'failed', 'cancelled'].includes(t.status)) {
      startWatcher(t);
      console.log(`[resume] watching ${t.id} in ${t.worktreePath}`);
    }
  }
  app.listen(PORT, () => {
    console.log(`devteam-board listening on http://localhost:${PORT}`);
    console.log(`  board file: ${BOARD_FILE}`);
    console.log(`  open the UI: http://localhost:${PORT}/`);
  });
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

main().catch((e) => { console.error(e); process.exit(1); });
