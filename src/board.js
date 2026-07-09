#!/usr/bin/env node
// devteam-board entrypoint. Single Node.js process that:
//   - manages ticket state in lowdb (board.json)
//   - creates git worktrees per ticket
//   - spawns `qwen -p "/devteam:build ..."` per ticket and supervises the subprocess
//   - parses emit-strings from stdout to update ticket stage
//   - serves a REST API + static UI on PORT
//
// All cross-process contracts with devteam are:
//   (a) stdout emit-strings (state)
//   (b) .devteam/plans/<id>/{analysis.md,stage2.merge.md} (artifacts)
//   (c) git worktree state (isolation)
// HITL is pre-flight only in v1 (see src/hitl.js).

import express from 'express';
import chokidar from 'chokidar';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initDb, getDb, getTicket, upsertTicket, patchTicket, deleteTicket, listTickets } from './db.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { startPipeline, getLogs, cancelPipeline } from './pipeline.js';
import { writeHitlResponse } from './hitl.js';
import { listProjects, getProjectsRoot } from './projects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BOARD_FILE = process.env.BOARD_FILE || join(__dirname, '..', 'board.json');

const STAGES = ['analytics', 'development', 'testing', 'admin'];

// --- State transitions ----------------------------------------------------

function applyEvent(ticket, emit) {
  const now = Date.now();
  switch (emit.kind || emit.type) {
    case 'stage_started':
      ticket.stage = emit.stage;
      ticket.substage = null;
      ticket.status = 'running';
      ticket.lastActivityAt = now;
      return true;
    case 'stage_completed':
      ticket.stage = emit.stage;
      ticket.stagesCompleted = Array.from(new Set([...(ticket.stagesCompleted || []), emit.stage]));
      ticket.lastActivityAt = now;
      const idx = STAGES.indexOf(emit.stage);
      if (idx === STAGES.length - 1) {
        ticket.status = 'completed';
        ticket.finishedAt = now;
      } else {
        ticket.substage = null;
      }
      return true;
    case 'stage_failed':
      ticket.status = 'failed';
      ticket.failureReason = `${emit.stage}: ${emit.raw}`;
      ticket.finishedAt = now;
      return true;
    case 'substage':
      ticket.substage = emit.groups[0];
      ticket.lastActivityAt = now;
      return true;
    case 'task_complete':
      ticket.status = 'completed';
      ticket.finishedAt = now;
      return true;
    case 'exit':
      if (ticket.status === 'running' || ticket.status === 'awaiting_approval') {
        ticket.status = emit.code === 0 ? 'completed' : 'failed';
        ticket.finishedAt = now;
      }
      ticket.exitCode = emit.code;
      ticket.exitSignal = emit.signal;
      return true;
    case 'hitl_paused':
      ticket.status = 'awaiting_approval';
      ticket.hitlReason = emit.groups?.[0] || emit.raw;
      ticket.lastActivityAt = now;
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
  if (t.status === 'running') {
    t.status = code === 0 ? 'completed' : 'failed';
    t.finishedAt = Date.now();
    t.exitCode = code;
    t.exitSignal = signal;
    upsertTicket(t);
  }
};

// --- Watcher: .devteam/plans/<id>/* for artifacts -------------------------

const watchers = new Map(); // ticketId -> chokidar watcher

function startWatcher(ticket) {
  if (watchers.has(ticket.id)) return;
  const plansDir = join(ticket.worktreePath, '.devteam', 'plans');
  const w = chokidar.watch(plansDir, {
    ignored: (p) => p.includes('/hitl/'),
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  w.on('add', (path) => {
    if (path.endsWith('analysis.md') && !ticket.analysisPath) {
      patchTicket(ticket.id, { analysisPath: path });
    } else if (path.endsWith('stage2.merge.md') && !ticket.stage2MergePath) {
      patchTicket(ticket.id, { stage2MergePath: path });
    }
  });
  watchers.set(ticket.id, w);
}

function stopWatcher(ticketId) {
  const w = watchers.get(ticketId);
  if (w) { w.close(); watchers.delete(ticketId); }
}

// --- HTTP API -------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true, tickets: listTickets().length }));

app.get('/api/projects', async (_req, res) => {
  res.json(await listProjects());
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
  const { lines, total } = getLogs(t.planId, since);
  res.json({ lines, total, since: total });
});

app.post('/api/tickets', async (req, res) => {
  const { title, workdir, base = 'main', branch, noNewBranch = false } = req.body || {};
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
  const ticket = {
    id,
    title,
    workdir,
    worktreePath,
    branch: branchName,
    base,
    noNewBranch,
    planId,
    status: 'backlog',
    stage: null,
    substage: null,
    stagesCompleted: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    qwenPid: null,
    exitCode: null,
    exitSignal: null,
    failureReason: null,
    hitlReason: null,
    analysisPath: null,
    stage2MergePath: null,
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
