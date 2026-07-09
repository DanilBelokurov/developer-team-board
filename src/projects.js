import { readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default scan root = parent of the board's repo root.
 * If board lives at <root>/devteam-board/src/projects.js, the default is <root>.
 * Override with the PROJECTS_ROOT env var.
 */
export function defaultProjectsRoot() {
  return resolve(__dirname, '..', '..');
}

export function getProjectsRoot() {
  return process.env.PROJECTS_ROOT
    ? resolve(process.env.PROJECTS_ROOT)
    : defaultProjectsRoot();
}

/**
 * Lists subdirectories of `root` that look like git repos. Excludes:
 *  - hidden entries (starting with '.')
 *  - the board's own directory (so we don't suggest devteam-board itself)
 *
 * Each entry: { name, path }. Sorted alphabetically by name.
 * If `root` cannot be read, returns the error string and an empty list —
 * the UI can still accept a typed path.
 */
export async function listProjects({ root } = {}) {
  const scanRoot = root || getProjectsRoot();
  const boardPath = resolve(__dirname, '..');
  let entries;
  try {
    entries = await readdir(scanRoot, { withFileTypes: true });
  } catch (e) {
    return { root: scanRoot, projects: [], error: String(e.message || e) };
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(scanRoot, entry.name);
    if (resolve(fullPath) === boardPath) continue;
    let isGit = false;
    try {
      const s = await stat(join(fullPath, '.git'));
      // .git can be either a directory (normal repo) or a file (submodule / worktree)
      isGit = s.isDirectory() || s.isFile();
    } catch {
      isGit = false;
    }
    if (!isGit) continue;
    projects.push({ name: entry.name, path: fullPath });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { root: scanRoot, projects };
}