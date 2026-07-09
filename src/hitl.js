import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// HITL bridge (v1 simplification: pre-flight approval only).
// In devteam v6.x, the pipeline's HITL gate uses ask_user_question (interactive).
// In non-interactive qwen -p mode we cannot satisfy that prompt, so for v1
// we treat approval as a pre-flight check done in the board UI BEFORE we spawn
// the pipeline. The devteam HITL gate itself is bypassed via --approval-mode yolo.
//
// The wire format below is what v2 will use to write back into the pipeline:
// .devteam/hitl/<plan-id>.json  ->  { decision, comment, at }

export async function writeHitlResponse({ worktreePath, planId, decision, comment }) {
  const dir = join(worktreePath, '.devteam', 'hitl');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${planId}.json`);
  await writeFile(file, JSON.stringify({ decision, comment, at: new Date().toISOString() }, null, 2));
  return file;
}

export async function readHitlResponse({ worktreePath, planId }) {
  try {
    const raw = await readFile(join(worktreePath, '.devteam', 'hitl', `${planId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listHitlResponses({ worktreePath }) {
  try {
    const dir = join(worktreePath, '.devteam', 'hitl');
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}
