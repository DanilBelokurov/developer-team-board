// Stage detection: maps tool_name (and tool input) emitted by devteam
// orchestrators to board-level stages (analytics / development / testing).
//
// In stream-json mode we detect stage transitions via tool_use payloads —
// the main pipeline-orchestrator invokes stages as SlashCommand / Skill /
// Agent calls, so we look at both the tool name and the inner command/agent.
//
// Names come from the `slash_commands` and `agents` arrays of the
// `system:init` event of qwen-cli v0.19.8.

export const STAGES = [
  {
    id: 'analytics',
    label: 'Analytics',
    patterns: [
      /^devteam:analyze$/i,
      /^analytics-orchestrator$/i,
      /^analytics-stage$/i,
      /^requirements-analyst$/i,
      /^db-schema-reader$/i,
      /^code-archaeologist$/i,
      /^api-spec-reader$/i,
    ],
  },
  {
    id: 'development',
    label: 'Development',
    patterns: [
      /^devteam:develop$/i,
      /^development-orchestrator$/i,
      /^development-stage$/i,
      /^kotlin-api-developer$/i,
      /^kotlin-data-architect$/i,
      /^kotlin-config-specialist$/i,
      /^kotlin-integration-specialist$/i,
    ],
  },
  {
    id: 'testing',
    label: 'Testing',
    patterns: [
      /^devteam:test$/i,
      /^testing-orchestrator$/i,
      /^testing-stage$/i,
      /^kotlin-unit-test-engineer$/i,
      /^kotlin-integration-test-engineer$/i,
      /^kotlin-e2e-test-engineer$/i,
      /^kotlin-quality-gate-enforcer$/i,
    ],
  },
];

/** Map a single tool name to a stage descriptor, or null if not a stage tool. */
export function detectStageFromToolName(toolName) {
  if (!toolName || typeof toolName !== 'string') return null;
  for (const stage of STAGES) {
    if (stage.patterns.some((re) => re.test(toolName))) return stage;
  }
  return null;
}

// Tool wrapper names used by qwen-cli to dispatch nested invocations.
// Inside these wrappers, the actual command/agent name lives in the input.
const WRAPPER_TOOLS = new Set([
  'SlashCommand',
  'slash_command',
  'Skill',
  'RunSkill',
  'Agent',
  'Task',
  'spawn_agent',
  'run_agent',
]);

/** Extract a candidate command/agent name from a tool_use input. */
function innerNameFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  return (
    input.command ||
    input.skill ||
    input.name ||
    input.subagent_type ||
    input.agent ||
    input.agent_name ||
    input.task ||
    null
  );
}

/**
 * Detect the stage implied by a tool_use event.
 * Returns { id, label } or null.
 */
export function detectStageFromToolUse(toolName, input) {
  const direct = detectStageFromToolName(toolName);
  if (direct) return direct;
  if (WRAPPER_TOOLS.has(toolName)) {
    const inner = innerNameFromInput(input);
    if (inner) return detectStageFromToolName(inner);
  }
  return null;
}