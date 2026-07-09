import { spawn } from 'node:child_process';
import { parseEmitLine } from './emit-parser.js';

const logBuffers = new Map(); // planId -> { lines: string[], offset: number }
const children = new Map();   // ticketId -> ChildProcess

const BUFFER_MAX = 2000;

export function startPipeline({ ticket, planId, worktreePath, qwenBin = 'qwen', onEvent, onExit }) {
  const prompt = buildPrompt(ticket);
  const child = spawn(qwenBin, [
    prompt,
    '--approval-mode', 'yolo',
    '--bare',
  ], {
    cwd: worktreePath,
    env: { ...process.env, QWEN_PLAN_ID: planId, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  logBuffers.set(planId, { lines: [], offset: 0 });
  children.set(ticket.id, child);

  let lineBuf = '';
  const handleChunk = (chunk, isErr = false) => {
    lineBuf += chunk.toString();
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop();
    const buf = logBuffers.get(planId);
    for (const line of parts) {
      const stamped = isErr ? `[stderr] ${line}` : line;
      buf.lines.push(stamped);
      if (buf.lines.length > BUFFER_MAX) buf.lines.shift();
      buf.offset++;
      const emit = parseEmitLine(line);
      if (emit) onEvent(planId, ticket.id, emit);
    }
  };

  child.stdout.on('data', (c) => handleChunk(c, false));
  child.stderr.on('data', (c) => handleChunk(c, true));

  child.on('exit', (code, signal) => {
    onEvent(planId, ticket.id, { type: 'exit', code, signal, raw: `exit code=${code} signal=${signal}` });
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
  const title = String(ticket.title).replace(/"/g, '\\"');
  return `/devteam:build --feature "${title}" --base ${ticket.base || 'main'} --no-push`;
}
