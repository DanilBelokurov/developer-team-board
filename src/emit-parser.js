// Parse stream-json events emitted by qwen-cli into board-level events.
//
// Each stdout line in `--output-format stream-json` mode is one JSON object.
// We return either null (not an event we care about) or an array of one or
// more normalized events for the board.
//
// Event kinds consumed by board.applyEvent:
//   - stage_started    { stage: 'analytics'|'development'|'testing' }
//   - stage_completed  { stage }
//   - substage         { groups: [<tool name>] }
//   - task_complete    {}
//   - hitl_paused      { groups: [<reason>] }
//
// Additional UI-only kinds (pushed into ticket.events[] / dedicated arrays):
//   - text             { text, source: 'assistant'|'user' }   — model prose
//   - log              { text, source: 'stdout'|'stderr' }    — raw line that
//                                                            didn't fit a typed
//                                                            event
//   - thinking         { text }
//   - tool_call        { id, name, input, stage }
//   - tool_result      { tool_use_id, content, is_error }
//   - system           { subtype, data, sessionId }
//   - result           { ok, subtype, durationMs, apiDurationMs, numTurns, usage, summary, error }

import { detectStageFromToolUse } from './stages.js';

// Track active stage transitions per session so we know when to emit
// stage_completed when a tool_result for a stage tool_use arrives.
const pendingStageByToolUse = new Map(); // tool_use_id -> stage.id

export function parseStreamJsonEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  switch (obj.type) {
    case 'assistant':
      return parseAssistant(obj);
    case 'user':
      return parseUser(obj);
    case 'system':
      return parseSystem(obj);
    case 'result':
      return parseResult(obj);
    default:
      return null;
  }
}

function parseAssistant(obj) {
  const blocks = (obj.message && Array.isArray(obj.message.content)) ? obj.message.content : [];
  const events = [];
  let detectedStage = null;
  let lastStageEventIndex = -1;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      const name = block.name || '';
      const stage = detectStageFromToolUse(name, block.input || {});
      if (stage && !detectedStage) detectedStage = stage;
      events.push({
        kind: 'tool_call',
        id: block.id,
        name,
        input: block.input || {},
        stage: stage ? { id: stage.id, label: stage.label } : null,
      });
      events.push({ kind: 'substage', groups: [name] });
      if (stage) {
        const stageEvent = { kind: 'stage_started', stage: stage.id, label: stage.label };
        events.push(stageEvent);
        lastStageEventIndex = events.length - 1;
        if (block.id) pendingStageByToolUse.set(block.id, stage.id);
      }
    } else if (block.type === 'text') {
      const text = block.text || '';
      // Assistant prose. We classify it as `text` (not `log`) so the UI
      // can render it with a different style (the actual model output is
      // what the user wants to read). Legacy markers embedded in the
      // text by devteam orchestrators (TASK_COMPLETE, HITL_PAUSED) are
      // promoted to their own typed events alongside the prose.
      events.push({ kind: 'text', text, source: 'assistant' });
      if (/\bTASK_COMPLETE\b/.test(text)) {
        events.push({ kind: 'task_complete' });
      }
      const hitlMatch = text.match(/HITL_PAUSED:?\s*([^\n]*)/i);
      if (hitlMatch) {
        events.push({ kind: 'hitl_paused', groups: [hitlMatch[1] || 'HITL_PAUSED'] });
      }
    } else if (block.type === 'thinking') {
      events.push({ kind: 'thinking', text: block.thinking || '' });
    }
  }
  return events.length ? events : null;
}

function parseUser(obj) {
  const blocks = (obj.message && Array.isArray(obj.message.content)) ? obj.message.content : [];
  const events = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      const content = stringifyContent(block.content);
      const toolUseId = block.tool_use_id || null;
      const isError = !!block.is_error;
      events.push({
        kind: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      });
      // If this tool_result closes a stage tool_use, emit stage_completed.
      if (toolUseId && pendingStageByToolUse.has(toolUseId)) {
        const stageId = pendingStageByToolUse.get(toolUseId);
        pendingStageByToolUse.delete(toolUseId);
        events.push({ kind: 'stage_completed', stage: stageId, ok: !isError });
      }
    } else if (block.type === 'text') {
      events.push({ kind: 'log', text: block.text || '', source: 'user' });
    }
  }
  return events.length ? events : null;
}

function parseSystem(obj) {
  const sub = obj.subtype;
  if (!sub) return null;
  // Storage-only subtypes — not relevant to the board.
  if (sub === 'custom_title' || sub === 'file_history_snapshot') return null;
  return [{
    kind: 'system',
    subtype: sub,
    data: obj.data || null,
    sessionId: obj.session_id || null,
  }];
}

function parseResult(obj) {
  // Drop pending stage tracking for this session — `result` is terminal.
  pendingStageByToolUse.clear();
  return [{
    kind: 'result',
    ok: !obj.is_error,
    subtype: obj.subtype || null,
    durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
    apiDurationMs: typeof obj.duration_api_ms === 'number' ? obj.duration_api_ms : null,
    numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : null,
    usage: obj.usage || null,
    summary: typeof obj.result === 'string' ? obj.result : null,
    permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials : [],
    error: obj.error || null,
  }];
}

function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      if (typeof c === 'object' && typeof c.text === 'string') return c.text;
      try { return JSON.stringify(c); } catch { return String(c); }
    }).join('\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

// --- Backward-compat shim --------------------------------------------------
// Old callers / tests may still pass a raw stdout line. We try JSON.parse and
// delegate to parseStreamJsonEvent. Non-JSON lines (which shouldn't appear
// in stream-json mode) are silently ignored.
export function parseEmitLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const obj = JSON.parse(trimmed);
    return parseStreamJsonEvent(obj);
  } catch {
    return null;
  }
}