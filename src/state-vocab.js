// Single source of truth for devTeam pipeline vocabulary.
//
// Mirrors the canonical values documented in:
//   - devTeam/QWEN.md            (§ State and persistence)
//   - devTeam/agents/pipeline-orchestrator.md
//   - devTeam/commands/devteam/build.md (§ 0 Initialize, § HITL gate)
//
// Every board module that needs to know "what are the valid pipeline
// states?" or "what colour does awaiting_hitl get?" must import from
// here. The frontend receives the same data via GET /api/vocab.

/**
 * @typedef {Object} VocabEntry
 * @property {string} id        Canonical value as written in state.md
 * @property {string} label     Human-readable label for UI
 * @property {string} token     CSS color token — resolved against a palette
 *                              on the frontend (see public/style.css)
 * @property {boolean} terminal True if this value means the pipeline is done
 * @property {number} order     Display order (low → left / top)
 * @property {string} [description] One-line explanation (optional)
 */

/** Pipeline status — the row `| Pipeline status | <X> |` in state.md. */
export const PIPELINE_STATUS = /** @type {VocabEntry[]} */ ([
  {
    id: 'pending',
    label: 'Pending',
    token: 'muted',
    terminal: false,
    order: 0,
    description: 'Initialized but no stage has started yet.',
  },
  {
    id: 'in_progress',
    label: 'Running',
    token: 'info',
    terminal: false,
    order: 1,
    description: 'At least one stage is in flight.',
  },
  {
    id: 'awaiting_hitl',
    label: 'Awaiting HITL',
    token: 'warning',
    terminal: false,
    order: 2,
    description: 'Paused at the analytics → development gate, waiting for human approval.',
  },
  {
    id: 'completed',
    label: 'Completed',
    token: 'success',
    terminal: true,
    order: 3,
    description: 'All non-skipped stages finished successfully.',
  },
  {
    id: 'failed',
    label: 'Failed',
    token: 'danger',
    terminal: true,
    order: 4,
    description: 'A stage exhausted its retries; pipeline halted.',
  },
  {
    id: 'aborted',
    label: 'Aborted',
    token: 'danger',
    terminal: true,
    order: 5,
    description: 'User aborted the pipeline at the HITL gate.',
  },
]);

/** Current stage — the row `| Current stage | <X> |` in state.md. */
export const CURRENT_STAGE = /** @type {VocabEntry[]} */ ([
  {
    id: 'none',
    label: '—',
    token: 'muted',
    terminal: false,
    order: 0,
    description: 'Pipeline not yet started.',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    token: 'stage-analytics',
    terminal: false,
    order: 1,
    description: 'Stage 1 — requirements, schema, code review.',
  },
  {
    id: 'development',
    label: 'Development',
    token: 'stage-development',
    terminal: false,
    order: 2,
    description: 'Stage 2 — parallel API/data/config/integration.',
  },
  {
    id: 'testing',
    label: 'Testing',
    token: 'stage-testing',
    terminal: false,
    order: 3,
    description: 'Stage 3 — unit, integration, e2e.',
  },
  {
    id: 'admin',
    label: 'Admin',
    token: 'stage-admin',
    terminal: false,
    order: 4,
    description: 'Stage 4 — branch + commit + push.',
  },
]);

/**
 * Per-stage status — each line of the form
 *   `- [ ] **<stage>** — <status>`
 * in state.md. `skipped` is a first-class value here even though
 * `skipped` never appears as a Pipeline status.
 */
export const STAGE_STATUS = /** @type {VocabEntry[]} */ ([
  {
    id: 'pending',
    label: 'Pending',
    token: 'muted',
    terminal: false,
    order: 0,
  },
  {
    id: 'in_progress',
    label: 'Running',
    token: 'info',
    terminal: false,
    order: 1,
  },
  {
    id: 'completed',
    label: 'Completed',
    token: 'success',
    terminal: true,
    order: 2,
  },
  {
    id: 'failed',
    label: 'Failed',
    token: 'danger',
    terminal: true,
    order: 3,
  },
  {
    id: 'skipped',
    label: 'Skipped',
    token: 'muted',
    terminal: true,
    order: 4,
    description: 'Stage was excluded by --skip-stage.',
  },
]);

/** HITL state — the row `| HITL state | <X> |` in state.md. */
export const HITL_STATE = /** @type {VocabEntry[]} */ ([
  {
    id: 'none',
    label: 'No HITL',
    token: 'muted',
    terminal: false,
    order: 0,
  },
  {
    id: 'paused_at_analytics',
    label: 'Paused at analytics',
    token: 'warning',
    terminal: false,
    order: 1,
    description: 'Pipeline stopped after Stage 1, awaiting human decision.',
  },
]);

/** HITL action — the row `| HITL action | <X> |` in state.md. */
export const HITL_ACTION = /** @type {VocabEntry[]} */ ([
  {
    id: 'none',
    label: '—',
    token: 'muted',
    terminal: false,
    order: 0,
  },
  {
    id: 'approve',
    label: 'Approve',
    token: 'success',
    terminal: false,
    order: 1,
    description: 'analysis.md accepted, proceed to Stage 2.',
  },
  {
    id: 'edit',
    label: 'Edit',
    token: 'info',
    terminal: false,
    order: 2,
    description: 'User will edit the plan manually before resuming.',
  },
  {
    id: 'request_changes',
    label: 'Request changes',
    token: 'warning',
    terminal: false,
    order: 3,
    description: 'Re-run Stage 1 with refined input.',
  },
  {
    id: 'abort',
    label: 'Abort',
    token: 'danger',
    terminal: true,
    order: 4,
    description: 'Stop the pipeline here, no further stages.',
  },
]);

/**
 * Legacy board status vocabulary (kept for the legacy `ticket.status`
 * column mapping). New code should derive ticket.status from
 * PIPELINE_STATUS via stateToBoardState() — see src/state-parser.js.
 */
export const BOARD_STATUS = /** @type {VocabEntry[]} */ ([
  {
    id: 'backlog',
    label: 'Backlog',
    token: 'muted',
    terminal: false,
    order: 0,
    description: 'Ticket created but pipeline not yet picked up.',
  },
  {
    id: 'running',
    label: 'Running',
    token: 'info',
    terminal: false,
    order: 1,
  },
  {
    id: 'awaiting_approval',
    label: 'Awaiting approval',
    token: 'warning',
    terminal: false,
    order: 2,
    description: 'Legacy alias for pipelineStatus=awaiting_hitl.',
  },
  {
    id: 'completed',
    label: 'Completed',
    token: 'success',
    terminal: true,
    order: 3,
  },
  {
    id: 'failed',
    label: 'Failed',
    token: 'danger',
    terminal: true,
    order: 4,
  },
  {
    id: 'cancelled',
    label: 'Cancelled',
    token: 'danger',
    terminal: true,
    order: 5,
    description: 'User cancelled via UI / SIGTERM, or pipeline aborted.',
  },
]);

/** All known planId stage names in canonical order. */
export const STAGE_IDS = /** @type {string[]} */ (['analytics', 'development', 'testing', 'admin']);

/** Lookup helper — returns VocabEntry by id or a fallback synthetic entry. */
export function lookup(list, id) {
  if (!id) return null;
  return list.find((e) => e.id === id) || null;
}

/** True if a pipelineStatus means the pipeline is no longer running. */
export function isTerminal(pipelineStatus) {
  const entry = lookup(PIPELINE_STATUS, pipelineStatus);
  return entry ? entry.terminal : false;
}

/** True if a per-stage status means the stage is no longer running. */
export function isStageTerminal(stageStatus) {
  const entry = lookup(STAGE_STATUS, stageStatus);
  return entry ? entry.terminal : false;
}

/**
 * Serialisable vocab snapshot for the frontend.
 * Frontend uses this to build columns and badges dynamically —
 * if devTeam adds a new pipelineStatus, the UI updates with no
 * frontend code change.
 */
export function exportVocab() {
  return {
    pipelineStatus: PIPELINE_STATUS,
    currentStage: CURRENT_STAGE,
    stageStatus: STAGE_STATUS,
    hitlState: HITL_STATE,
    hitlAction: HITL_ACTION,
    boardStatus: BOARD_STATUS,
    stageIds: STAGE_IDS,
  };
}