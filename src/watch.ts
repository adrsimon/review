import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * Tells the server when the worktree may have moved.
 *
 * The watcher is only a hint: every trigger schedules a recompute, and the diff
 * itself is what decides whether anything changed. That makes a spurious event
 * cheap and a missed one survivable, which matters because recursive watching is
 * unavailable on Linux before Node 20 and because editors move files in ways no
 * watcher reports cleanly. The poll underneath is the floor.
 */

const DEBOUNCE_MS = 150;
const POLL_MS = 2000;

/** Churn that never belongs to a diff, and that npm can emit by the thousand. */
const IGNORED = /(^|[\\/])(node_modules|dist|build|target|\.next|coverage|\.turbo|__pycache__)([\\/]|$)/;
/** Inside .git only these matter: the rest is object churn from git's own bookkeeping. */
const GIT_INTERESTING = /^\.git[\\/](HEAD|index|MERGE_HEAD|refs[\\/]|worktrees[\\/][^\\/]+[\\/](HEAD|index))/;

export interface Watcher {
  close: () => void;
}

export function watchRepo(cwd: string, onChange: () => void): Watcher {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, DEBOUNCE_MS);
  };

  const relevant = (rel: string | null): boolean => {
    if (!rel) return true; // no filename reported, so assume it counts
    const norm = rel.split(path.sep).join("/");
    if (norm.startsWith(".git/") || norm === ".git") return GIT_INTERESTING.test(rel);
    return !IGNORED.test(norm);
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (relevant(filename ? String(filename) : null)) schedule();
    });
    watcher.on("error", () => {});
  } catch {
    // Recursive watching is unsupported here; the poll carries it alone.
  }

  const poll = setInterval(schedule, POLL_MS);
  poll.unref();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
