// Parse stdout lines emitted by devteam orchestrators into structured events.
// Keep this list in sync with the emit-strings produced by:
//   - agents/pipeline-orchestrator.md
//   - agents/{analytics,development,testing,admin}-orchestrator.md
//   - agents/git-admin-developer.md

const PATTERNS = [
  { re: /^STAGE\s+(\d+)\s+COMPLETED/i, type: 'stage_completed', stageFromNum: true },
  { re: /^STAGE\s+(\d+)\s+FAILED/i, type: 'stage_failed', stageFromNum: true },
  { re: /^STAGE\s+(\d+)\s+STARTED/i, type: 'stage_started', stageFromNum: true },
  { re: /^TASK_COMPLETE:\s*(\S+)/i, type: 'task_complete' },
  { re: /^EXIT_SIGNAL:\s*(\S+)/i, type: 'exit_signal' },
  { re: /^HITL_PAUSED:?\s*(.*)/i, type: 'hitl_paused' },
  { re: /^ANALYTICS_COMPLETED/i, type: 'stage_completed', stage: 'analytics' },
  { re: /^DEVELOPMENT_COMPLETED/i, type: 'stage_completed', stage: 'development' },
  { re: /^TESTING_COMPLETED/i, type: 'stage_completed', stage: 'testing' },
  { re: /^ADMIN_COMPLETED/i, type: 'stage_completed', stage: 'admin' },
  { re: /^GIT_ADMIN_COMPLETED/i, type: 'stage_completed', stage: 'admin' },
  { re: /^\[substage\]\s*(\S+)/i, type: 'substage' },
];

const STAGE_NUM_TO_NAME = { 1: 'analytics', 2: 'development', 3: 'testing', 4: 'admin' };

export function parseEmitLine(line) {
  for (const { re, type, stageFromNum, stage } of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const out = { type, raw: line, groups: m.slice(1) };
    if (stageFromNum) {
      out.stage = STAGE_NUM_TO_NAME[m[1]] || `stage-${m[1]}`;
    } else if (stage) {
      out.stage = stage;
    }
    return out;
  }
  return null;
}
