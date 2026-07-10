// Parser for .devteam/plans/<plan-id>/state.md
//
// The devTeam orchestrators write state.md with a stable structure
// (see commands/devteam/build.md § 0). This module extracts that
// structure into a JS object and projects it onto the board's
// ticket schema.
//
// State.md layout (canonical):
//
//   # Pipeline State — <plan-id>
//
//   | Field           | Value      |
//   |---|---|
//   | Plan ID         | <id>       |
//   | Feature         | <text>     |
//   | Created         | <iso>      |
//   | Updated         | <iso>      |
//   | Current stage   | <stage>    |
//   | Pipeline status | <status>   |
//   | HITL state      | <h-state>  |
//   | HITL action     | <h-action> |
//
//   ## Stages
//
//   - [x] **analytics**    — completed
//   - [ ] **development**  — in_progress
//   - [ ] **testing**      — pending
//   - [ ] **admin**        — pending
//
//   ## Last event
//
//   2026-07-10T08:00:00Z — Stage "analytics" set to "in_progress".

import { readFile } from 'node:fs/promises';
import {
  PIPELINE_STATUS,
  CURRENT_STAGE,
  STAGE_STATUS,
  HITL_STATE,
  HITL_ACTION,
  STAGE_IDS,
  lookup,
} from './state-vocab.js';

/**
 * @typedef {Object} StateSnapshot
 * @property {string|null} planId
 * @property {string|null} feature
 * @property {string|null} created     ISO 8601 UTC
 * @property {string|null} updated     ISO 8601 UTC
 * @property {string|null} currentStage
 * @property {string|null} pipelineStatus
 * @property {string|null} hitlState
 * @property {string|null} hitlAction
 * @property {Object<string,'pending'|'in_progress'|'completed'|'failed'|'skipped'|null>} stages
 *           keyed by stage id (analytics/development/testing/admin)
 * @property {string|null} lastEvent    raw text of the Last event paragraph
 * @property {string|null} raw          original file text (for diffing)
 * @property {string|null} path         file path on disk, if parsed from disk
 * @property {number} parsedAt          ms since epoch when parsed
 */

/** Match a row of the form `| Field | Value |` (extra whitespace tolerated). */
const ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/;

/** Match a stage line `- [x| ] **<id>** — <status>`. */
const STAGE_LINE_RE = /^-\s*\[(.)\]\s*\*\*(\w+)\*\*\s*—\s*(\S+)/;

/**
 * Parse the text of a state.md file. Returns a StateSnapshot — fields
 * that could not be found are `null` (NOT undefined, so JSON serialization
 * is stable for the frontend).
 *
 * @param {string} text  raw file text
 * @param {string} [path]  optional file path, stored on the result
 * @returns {StateSnapshot}
 */
export function parseStateMd(text, path) {
  if (typeof text !== 'string') text = String(text ?? '');
  const snap = emptySnapshot(path);

  const lines = text.split(/\r?\n/);
  let inStages = false;
  let inLastEvent = false;
  const lastEventLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, '');

    if (line.startsWith('## Stages')) {
      inStages = true;
      inLastEvent = false;
      continue;
    }
    if (line.startsWith('## Last event')) {
      inStages = false;
      inLastEvent = true;
      continue;
    }
    if (line.startsWith('## ') || line.startsWith('# ')) {
      inStages = false;
      inLastEvent = false;
    }

    if (inStages) {
      const m = STAGE_LINE_RE.exec(line);
      if (m) {
        const done = m[1] === 'x';
        const stageId = m[2].toLowerCase();
        const statusRaw = m[3].toLowerCase();
        if (STAGE_IDS.includes(stageId)) {
          snap.stages[stageId] = normalizeStageStatus(statusRaw, done);
        }
      }
      continue;
    }

    if (inLastEvent) {
      if (line.trim()) lastEventLines.push(line.trim());
      continue;
    }

    const m = ROW_RE.exec(line);
    if (!m) continue;
    const field = m[1].trim().toLowerCase();
    const value = m[2].trim();

    switch (field) {
      case 'plan id':
        snap.planId = value || null;
        break;
      case 'feature':
        snap.feature = value || null;
        break;
      case 'created':
        snap.created = value || null;
        break;
      case 'updated':
        snap.updated = value || null;
        break;
      case 'current stage':
        snap.currentStage = normalizeCurrentStage(value);
        break;
      case 'pipeline status':
        snap.pipelineStatus = normalizePipelineStatus(value);
        break;
      case 'hitl state':
        snap.hitlState = normalizeHitlState(value);
        break;
      case 'hitl action':
        snap.hitlAction = normalizeHitlAction(value);
        break;
    }
  }

  snap.lastEvent = lastEventLines.length ? lastEventLines.join(' ') : null;
  snap.raw = text;
  return snap;
}

function emptySnapshot(path) {
  return {
    planId: null,
    feature: null,
    created: null,
    updated: null,
    currentStage: null,
    pipelineStatus: null,
    hitlState: null,
    hitlAction: null,
    stages: {
      analytics: null,
      development: null,
      testing: null,
      admin: null,
    },
    lastEvent: null,
    raw: null,
    path: path || null,
    parsedAt: Date.now(),
  };
}

function normalizePipelineStatus(v) {
  if (!v) return null;
  const lower = v.toLowerCase();
  return lookup(PIPELINE_STATUS, lower) ? lower : lower; // pass through unknown — vocab is open
}
function normalizeCurrentStage(v) {
  if (!v) return null;
  const lower = v.toLowerCase();
  return lookup(CURRENT_STAGE, lower) ? lower : lower;
}
function normalizeHitlState(v) {
  if (!v) return null;
  const lower = v.toLowerCase();
  return lookup(HITL_STATE, lower) ? lower : lower;
}
function normalizeHitlAction(v) {
  if (!v) return null;
  const lower = v.toLowerCase();
  return lookup(HITL_ACTION, lower) ? lower : lower;
}
function normalizeStageStatus(raw, done) {
  // The orchestrator writes the actual status after the em-dash. But on
  // some old revisions the box might be checked [x] while the em-dash
  // status says "pending" — treat [x] as authoritative when the em-dash
  // value is unknown, but never override an explicit non-pending value.
  const lower = (raw || '').toLowerCase();
  if (lookup(STAGE_STATUS, lower)) return lower;
  return done ? 'completed' : 'pending';
}

/**
 * Parse state.md straight from disk.
 * Returns null if the file cannot be read (does not throw).
 */
export async function parseStateMdFile(path) {
  try {
    const text = await readFile(path, 'utf8');
    return parseStateMd(text, path);
  } catch {
    return null;
  }
}

/**
 * Project a StateSnapshot onto the legacy board ticket fields.
 * The board still tracks `ticket.status` (one of backlog/running/...) for
 * backwards compatibility with the UI columns, but every projection
 * here is purely a function of the snapshot — there is no second source
 * of truth.
 *
 * @param {StateSnapshot} snap
 * @returns {{
 *   status: 'backlog'|'running'|'awaiting_approval'|'completed'|'failed'|'cancelled',
 *   stage: 'analytics'|'development'|'testing'|'admin'|null,
 *   stagesCompleted: string[],
 *   stagesSkipped: string[],
 *   hitlAction: string|null,
 *   hitlState: string|null,
 * }}
 */
export function stateToBoardState(snap) {
  const ps = snap.pipelineStatus;
  const cur = snap.currentStage;

  // Map pipeline status → board status (legacy column model).
  let status;
  switch (ps) {
    case 'pending':
    case null:
      status = 'backlog';
      break;
    case 'in_progress':
      status = 'running';
      break;
    case 'awaiting_hitl':
      status = 'awaiting_approval';
      break;
    case 'completed':
      status = 'completed';
      break;
    case 'failed':
      status = 'failed';
      break;
    case 'aborted':
      status = 'cancelled';
      break;
    default:
      // Unknown pipeline status — keep the previous behaviour (running)
      // rather than dropping the ticket to backlog.
      status = 'running';
  }

  // Per-stage: prefer explicit status; treat 'none' as null stage.
  const stagesCompleted = [];
  const stagesSkipped = [];
  for (const id of STAGE_IDS) {
    const s = snap.stages[id];
    if (s === 'completed') stagesCompleted.push(id);
    else if (s === 'skipped') stagesSkipped.push(id);
  }

  return {
    status,
    stage: cur && cur !== 'none' ? cur : null,
    stagesCompleted,
    stagesSkipped,
    hitlAction: snap.hitlAction,
    hitlState: snap.hitlState,
  };
}

/**
 * True iff two StateSnapshots are field-equal for the rows that matter
 * to the board. We intentionally ignore `raw` and `parsedAt` — those
 * change on every re-read.
 */
export function snapshotsEqualForBoard(a, b) {
  if (!a || !b) return a === b;
  if (a.planId !== b.planId) return false;
  if (a.feature !== b.feature) return false;
  if (a.currentStage !== b.currentStage) return false;
  if (a.pipelineStatus !== b.pipelineStatus) return false;
  if (a.hitlState !== b.hitlState) return false;
  if (a.hitlAction !== b.hitlAction) return false;
  for (const id of STAGE_IDS) {
    if (a.stages[id] !== b.stages[id]) return false;
  }
  return true;
}