import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

function slugify(branch) {
  return branch.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function worktreePathFor(repoPath, branch) {
  const slug = slugify(branch);
  return `${repoPath.replace(/\/+$/, '')}-${slug}`;
}

export async function createWorktree({ repoPath, branch, base = 'main' }) {
  const wtPath = worktreePathFor(repoPath, branch);
  await pExecFile('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, wtPath, base], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return wtPath;
}

export async function removeWorktree({ repoPath, wtPath, force = true }) {
  try {
    await pExecFile('git', ['-C', repoPath, 'worktree', 'remove', force ? '--force' : '', wtPath].filter(Boolean));
  } catch (e) {
    // try prune then retry once
    await pExecFile('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
    await pExecFile('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath]);
  }
}

export async function listWorktrees(repoPath) {
  const { stdout } = await pExecFile('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return stdout.trim();
}
