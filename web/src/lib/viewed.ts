import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffFile, Revs } from "../../../src/types.ts";

/**
 * Which files the reader has cleared, as a set of `path@hash` keys.
 *
 * Keying on the content hash does the invalidation: when an agent rewrites a
 * file, its key stops matching and the file comes back unviewed on its own. The
 * path is still remembered, which is what lets the UI say "this changed since
 * you read it" without storing that separately.
 */

/**
 * Worktree and staged reviews key on the mode alone. Pinning them to the
 * resolved sha would throw the reader's progress away every time the agent
 * commits, which is exactly when they least want to start over. Content hashes
 * already handle invalidation, so the range is only needed when the user named
 * one explicitly.
 */
function storageKey(repo: string, revs: Revs): string {
  if (!repo || !revs.mode) return "";
  if (revs.mode === "range") return `review:viewed:${repo}:range:${revs.base}..${revs.head}`;
  return `review:viewed:${repo}:${revs.mode}`;
}

function load(key: string): Set<string> {
  if (!key) return new Set();
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export interface Viewed {
  isViewed: (file: DiffFile) => boolean;
  /** Read at an earlier hash, then rewritten. */
  hasChangedSinceRead: (file: DiffFile) => boolean;
  toggle: (file: DiffFile) => void;
  setAll: (files: DiffFile[], viewed: boolean) => void;
  count: number;
}

export function useViewed(repo: string, revs: Revs, files: DiffFile[]): Viewed {
  const key = storageKey(repo, revs);
  const [keys, setKeys] = useState<Set<string>>(() => load(key));

  useEffect(() => setKeys(load(key)), [key]);

  useEffect(() => {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(Array.from(keys)));
    } catch {
      // Private windows and cleared site data both land here; viewed state is
      // a convenience, so losing it costs the reader nothing but a re-read.
    }
  }, [key, keys]);

  const readPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const k of keys) paths.add(k.slice(0, k.lastIndexOf("@")));
    return paths;
  }, [keys]);

  const isViewed = useCallback((file: DiffFile) => keys.has(`${file.path}@${file.hash}`), [keys]);

  const hasChangedSinceRead = useCallback(
    (file: DiffFile) => !keys.has(`${file.path}@${file.hash}`) && readPaths.has(file.path),
    [keys, readPaths],
  );

  const toggle = useCallback((file: DiffFile) => {
    setKeys((prev) => {
      const next = new Set(prev);
      const k = `${file.path}@${file.hash}`;
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const setAll = useCallback((list: DiffFile[], viewed: boolean) => {
    setKeys((prev) => {
      const next = new Set(prev);
      for (const f of list) {
        const k = `${f.path}@${f.hash}`;
        if (viewed) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);

  const count = useMemo(() => files.filter((f) => keys.has(`${f.path}@${f.hash}`)).length, [files, keys]);

  return { isViewed, hasChangedSinceRead, toggle, setAll, count };
}
