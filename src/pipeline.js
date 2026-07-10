import { spawn } from 'node:child_process';
import { parseStreamJsonEvent } from './emit-parser.js';

/**
 * Log buffer per ticket. We store STRUCTURED entries (timestamped events
 * from the stream-json parser), not raw stdout lines — the Log tab on
 * the UI renders them as a human-readable timeline. The raw stream-json
 * is still preserved on the ticket's `events` field for the Events tab.
 *
 * Entry shape: { ts: number, kind: string, ...payload } where kind is
 * one of: tool_call, tool_result, thinking, text, stage_started,
 * stage_completed, substage, hitl_paused, task_complete, system,
 * result, exit, log.
 */
const logBuffers = new Map(); // ticketId -> { entries: LogEntry[], offset: number, planIdAtSpawn }
const children = new Map();   // ticketId -> ChildProcess

const BUFFER_MAX = 2000;

export function startPipeline({ ticket, planId, worktreePath, qwenBin = 'qwen', resumeSessionId, onEvent, onExit }) {
  const args = [
    '--approval-mode', 'yolo',
    '--bare',
    '--output-format', 'stream-json',
  ];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }
  args.push(buildPrompt(ticket));

  const child = spawn(qwenBin, args, {
    cwd: worktreePath,
    env: { ...process.env, QWEN_PLAN_ID: planId, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Key the log buffer on ticketId, NOT planId — the ticket's planId may
  // be rebound by the state-watcher when state.md is read (the legacy
  // `plan-<ts>-<uuid>` placeholder is replaced with the real devTeam
  // `<slug>-<6hex>`). Keying on ticketId keeps the log stream attached
  // to the ticket across the rebind.
  logBuffers.set(ticket.id, { entries: [], offset: 0, planIdAtSpawn: planId });
  children.set(ticket.id, child);

  let lineBuf = '';
  let stderrBuf = '';

  const record = (entry) => {
    const buf = logBuffers.get(ticket.id);
    if (!buf) return;
    buf.entries.push(entry);
    if (buf.entries.length > BUFFER_MAX) buf.entries.shift();
    buf.offset++;
  };

  const processLine = (line, isErr) => {
    const trimmed = line.trim();
    if (!trimmed && !isErr) return;

    // stderr or non-JSON stdout: fall back to a generic `log` entry.
    if (isErr || trimmed[0] !== '{') {
      const entry = {
        ts: Date.now(),
        kind: 'log',
        text: isErr ? line : (line || '(empty line)'),
        source: isErr ? 'stderr' : 'stdout',
      };
      record(entry);
      onEvent(planId, ticket.id, entry);
      return;
    }

    // stream-json: every non-empty line is a JSON object that may carry
    // one or more logical events. Each event becomes a separate log entry.
    try {
      const obj = JSON.parse(trimmed);
      const events = parseStreamJsonEvent(obj);
      if (!events) {
        // The parser didn't recognise the event type — keep it as a raw log
        // entry so the user can see it (e.g. future stream-json additions).
        record({ ts: Date.now(), kind: 'log', text: trimmed, source: 'stdout' });
        return;
      }
      for (const e of events) {
        const entry = { ts: Date.now(), ...e };
        record(entry);
        onEvent(planId, ticket.id, e);
      }
    } catch {
      // JSON.parse failed — keep as a log entry, don't drop it.
      record({ ts: Date.now(), kind: 'log', text: trimmed, source: 'stdout' });
    }
  };

  const handleChunk = (chunk, isErr) => {
    let buf = isErr ? stderrBuf : lineBuf;
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    if (isErr) stderrBuf = buf;
    else lineBuf = buf;
    for (const line of parts) processLine(line, isErr);
  };

  child.stdout.on('data', (c) => handleChunk(c, false));
  child.stderr.on('data', (c) => handleChunk(c, true));

  child.on('exit', (code, signal) => {
    const exitEvent = {
      ts: Date.now(),
      kind: 'exit',
      code,
      signal,
      raw: `exit code=${code} signal=${signal}`,
    };
    record(exitEvent);
    onEvent(planId, ticket.id, exitEvent);
    onExit(ticket.id, code, signal);
    // keep buffer for a grace period so UI can still fetch logs
    setTimeout(() => {
      logBuffers.delete(ticket.id);
      children.delete(ticket.id);
    }, 60_000);
  });

  return child;
}

export function getLogs(ticketId, since = 0) {
  const buf = logBuffers.get(ticketId);
  if (!buf) return { entries: [], total: 0 };
  return { entries: buf.entries.slice(since), total: buf.entries.length };
}

export function cancelPipeline(ticketId) {
  const child = children.get(ticketId);
  if (!child) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve(true);
    }, 5000);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(t); resolve(false); }
  });
}

function buildPrompt(ticket) {
  // /devteam:build with positional feature; --no-push keeps everything local
  // (board does not auto-push; that's an admin-stage decision the user can make later)
  const title = String(ticket.title || ticket._resumePrompt || '').replace(/"/g, '\\"');
  return `/devteam:build --feature "${title}" --base ${ticket.base || 'main'} --no-push`;
}