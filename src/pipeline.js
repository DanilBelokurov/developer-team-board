import { spawn } from 'node:child_process';
import { parseStreamJsonEvent } from './emit-parser.js';

const logBuffers = new Map(); // planId -> { lines: string[], offset: number }
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

  logBuffers.set(planId, { lines: [], offset: 0 });
  children.set(ticket.id, child);

  let lineBuf = '';
  let stderrBuf = '';

  const processLine = (line, isErr) => {
    const buf = logBuffers.get(planId);
    if (isErr) {
      buf.lines.push(`[stderr] ${line}`);
      if (buf.lines.length > BUFFER_MAX) buf.lines.shift();
      buf.offset++;
      onEvent(planId, ticket.id, { kind: 'log', text: line, source: 'stderr' });
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    buf.lines.push(line);
    if (buf.lines.length > BUFFER_MAX) buf.lines.shift();
    buf.offset++;
    // stream-json: every non-empty line is a JSON object.
    if (trimmed[0] === '{') {
      try {
        const obj = JSON.parse(trimmed);
        const events = parseStreamJsonEvent(obj);
        if (events) {
          for (const e of events) onEvent(planId, ticket.id, e);
        }
      } catch {
        onEvent(planId, ticket.id, { kind: 'log', text: line, source: 'stdout' });
      }
    } else {
      onEvent(planId, ticket.id, { kind: 'log', text: line, source: 'stdout' });
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
    onEvent(planId, ticket.id, { kind: 'exit', type: 'exit', code, signal, raw: `exit code=${code} signal=${signal}` });
    onExit(ticket.id, code, signal);
    // keep buffer for a grace period so UI can still fetch logs
    setTimeout(() => {
      logBuffers.delete(planId);
      children.delete(ticket.id);
    }, 60_000);
  });

  return child;
}

export function getLogs(planId, since = 0) {
  const buf = logBuffers.get(planId);
  if (!buf) return { lines: [], total: 0 };
  return { lines: buf.lines.slice(since), total: buf.lines.length };
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