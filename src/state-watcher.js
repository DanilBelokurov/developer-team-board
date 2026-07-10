// Watcher for devTeam state.md (authoritative pipeline state).
//
// This module replaces the previous chokidar watcher that only picked up
// `analysis.md` and `stage2.merge.md`. The new watcher:
//   1. Discovers existing plan directories under .devteam/plans/ on attach,
//      so a ticket can bind to a planId even if it was created before the
//      pipeline started (worktrees that pre-date the run).
//   2. Watches .devteam/plans/*/state.md for live transitions, with
//      awaitWriteFinish to avoid partial writes.
//   3. Reports only snapshot diffs (snapshotsEqualForBoard) — no thrash.
//   4. Continues to pick up analysis.md, stage2.merge.md, hitl.md, and
//      plans/*.md review files for the UI to display.
//
// The watcher is bound to a single ticket. It scans the worktree
// directly; if the worktree is moved or the ticket is deleted, the
// caller MUST call close() to release the chokidar handles.

import chokidar from 'chokidar';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseStateMd, snapshotsEqualForBoard } from './state-parser.js';

/** Regex matching the devTeam planId format `<feature-slug>-<6 hex>`. */
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{6}$/;

/**
 * Scan .devteam/plans/* under a worktree and return the plan ids whose
 * directory exists (whether or not state.md is present yet).
 *
 * @param {string} worktreePath
 * @returns {Promise<string[]>}
 */
export async function discoverPlanDirs(worktreePath) {
  const root = join(worktreePath, '.devteam', 'plans');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Skip hidden subdirs (e.g. '.tmp'); accept anything that looks
      // like a planId, but don't reject unknown shapes — devTeam could
      // in theory add a non-conforming id and we still want to watch it.
      if (e.name.startsWith('.')) continue;
      out.push(e.name);
    }
    return out.sort();
  } catch {
    return [];
  }
}

/**
 * @typedef {Object} StateWatcherOptions
 * @property {string} worktreePath
 * @property {(evt: { kind: 'snapshot', planId: string, snapshot: import('./state-parser.js').StateSnapshot, prev: import('./state-parser.js').StateSnapshot|null }) => void} onSnapshot
 * @property {(evt: { kind: 'plan_discovered', planId: string, dirPath: string }) => void} [onPlanDiscovered]
 * @property {(evt: { kind: 'artifact', planId: string, file: 'analysis'|'stage2_merge'|'hitl'|'review', path: string }) => void} [onArtifact]
 */

/**
 * Build a watcher. Returns { close(), scan(), getSnapshots() }.
 * The caller MUST call close() when the ticket is deleted to release
 * the chokidar handle.
 *
 * @param {StateWatcherOptions} opts
 */
export function createStateWatcher(opts) {
  const { worktreePath, onSnapshot, onPlanDiscovered, onArtifact } = opts;

  /** @type {Map<string, import('./state-parser.js').StateSnapshot|null>} planId → last snapshot */
  const snapshots = new Map();
  /** @type {Map<string, string>} planId → plan dir path */
  const planDirs = new Map();
  /** @type {Map<string, Set<string>>} planId → set of artifact files already reported */
  const reportedArtifacts = new Map();

  const plansRoot = join(worktreePath, '.devteam', 'plans');

  let watcher = null;
  let closed = false;

  const fileKey = (planId, file) => `${planId}::${file}`;

  const planIdFromPath = (p) => {
    // path is something like /.../worktree/.devteam/plans/<planId>/<file>
    const idx = p.indexOf('.devteam/plans/');
    if (idx < 0) return null;
    const tail = p.slice(idx + '.devteam/plans/'.length);
    const slash = tail.indexOf('/');
    if (slash < 0) return null;
    return tail.slice(0, slash);
  };

  const artifactKindFor = (file) => {
    if (file === 'analysis.md') return 'analysis';
    if (file === 'stage2.merge.md') return 'stage2_merge';
    if (file === 'hitl.md') return 'hitl';
    if (/^[0-9][0-9]-review-\d+\.md$/.test(file) || file === '00-original.md' || file === 'final.md') {
      return 'review';
    }
    return null;
  };

  const handleStateFile = async (path) => {
    if (closed) return;
    const planId = planIdFromPath(path);
    if (!planId) return;
    let snap;
    try {
      const text = await readFile(path, 'utf8');
      snap = parseStateMd(text, path);
    } catch {
      return;
    }
    if (snap.planId && snap.planId !== planId) {
      // state.md declares a different planId than its directory — that
      // shouldn't happen, but if it does we trust the directory.
      snap.planId = planId;
    }
    const prev = snapshots.get(planId) || null;
    if (snapshotsEqualForBoard(prev, snap)) return;
    snapshots.set(planId, snap);
    onSnapshot({ kind: 'snapshot', planId, snapshot: snap, prev });
  };

  const handlePlanDir = (dirPath) => {
    if (closed) return;
    const planId = basename(dirPath);
    if (planDirs.has(planId)) return;
    planDirs.set(planId, dirPath);
    if (onPlanDiscovered) {
      onPlanDiscovered({ kind: 'plan_discovered', planId, dirPath });
    }
  };

  const handleArtifact = (path) => {
    if (closed) return;
    const planId = planIdFromPath(path);
    if (!planId) return;
    const file = basename(path);
    const kind = artifactKindFor(file);
    if (!kind) return;
    const seen = reportedArtifacts.get(planId) || new Set();
    const key = fileKey(planId, file);
    if (seen.has(key)) return;
    seen.add(key);
    reportedArtifacts.set(planId, seen);
    if (onArtifact) {
      onArtifact({ kind: 'artifact', planId, file: kind, path });
    }
  };

  const handle = (path) => {
    if (!path) return;
    if (path.endsWith('/state.md')) return handleStateFile(path);
    if (/\.devteam\/plans\/[^/]+$/.test(path) && !path.endsWith('/plans')) {
      return handlePlanDir(path);
    }
    if (path.includes('.devteam/plans/') && path.indexOf('/state.md') < 0) {
      return handleArtifact(path);
    }
  };

  /**
   * Initial scan: walks .devteam/plans/ once and reports any existing
   * plan dirs and their state.md snapshots. Safe to call multiple times
   * — the watcher de-duplicates by planId and snapshot equality.
   */
  const scan = async () => {
    if (closed) return;
    let entries = [];
    try {
      const s = await stat(plansRoot);
      if (!s.isDirectory()) return;
      entries = await readdir(plansRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dirPath = join(plansRoot, e.name);
      handlePlanDir(dirPath);
      const stateFile = join(dirPath, 'state.md');
      try {
        const s = await stat(stateFile);
        if (s.isFile()) await handleStateFile(stateFile);
      } catch {
        // state.md not yet written — that's fine.
      }
    }
  };

  watcher = chokidar.watch(plansRoot, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (p) => {
      // Allow the plans root and everything under it; only skip hidden files.
      if (p === plansRoot) return false;
      const base = basename(p);
      return base.startsWith('.') && base !== '.devteam';
    },
  });

  watcher
    .on('add', handle)
    .on('change', handle)
    .on('addDir', (p) => { if (p !== plansRoot) handlePlanDir(p); });

  return {
    /** Re-scan disk (e.g. after a resume that re-uses the worktree). */
    scan,
    /** Stop the watcher and release handles. */
    close: async () => {
      if (closed) return;
      closed = true;
      if (watcher) {
        try { await watcher.close(); } catch { /* ignore */ }
        watcher = null;
      }
    },
    /** All known snapshots, keyed by planId. */
    getSnapshots: () => new Map(snapshots),
    /** All known plan dirs, keyed by planId. */
    getPlanDirs: () => new Map(planDirs),
    /** Test helper — return true if the watcher is closed. */
    isClosed: () => closed,
  };
}