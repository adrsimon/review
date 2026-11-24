import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewComment, ReviewState, ReviewVerdict, TelemetryEvent } from "../../../src/types.ts";

/**
 * The review being written in a training session. The page owns the state and
 * pushes all of it on every change: a review is a few kilobytes, and sending
 * the whole thing means the file on disk is always one coherent review rather
 * than the sum of patches that may have raced.
 */

export interface CommentDraft {
  path: string;
  side: "base" | "head";
  line: number | null;
  endLine: number | null;
  excerpt: string[];
}

export interface Review {
  ready: boolean;
  state: ReviewState;
  /** Last save failed; the next change retries. */
  error: string | null;
  add: (draft: CommentDraft, body: string) => void;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  setSummary: (summary: string) => void;
  setVerdict: (verdict: ReviewVerdict) => void;
  submit: () => void;
  byPath: Map<string, ReviewComment[]>;
}

const EMPTY: ReviewState = { comments: [], summary: "", verdict: null, submittedAt: null };
const TYPING_DEBOUNCE_MS = 400;

async function save(state: ReviewState): Promise<void> {
  const res = await fetch("/api/review", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`could not save the review (${res.status})`);
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function useReview(enabled: boolean): Review {
  const [state, setState] = useState<ReviewState>(EMPTY);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef(0);
  // The latest state, so a change can be computed and saved outside a React
  // updater: updaters run twice in strict mode and must not have effects.
  const current = useRef<ReviewState>(EMPTY);
  const commit = useCallback((next: ReviewState) => {
    current.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void fetch("/api/review")
      .then((r) => r.json() as Promise<ReviewState>)
      .then((loaded) => {
        commit(loaded);
        setReady(true);
      })
      .catch((err: Error) => setError(err.message));
  }, [enabled, commit]);

  const persist = useCallback((next: ReviewState, debounce: boolean) => {
    window.clearTimeout(timer.current);
    const run = () =>
      save(next).then(
        () => setError(null),
        (err: Error) => setError(err.message),
      );
    if (debounce) timer.current = window.setTimeout(run, TYPING_DEBOUNCE_MS);
    else void run();
  }, []);

  // Any change after "done" reopens the review: what gets graded is what is
  // on disk, and "done" should mean the reviewer stood behind all of it.
  const change = useCallback(
    (fn: (prev: ReviewState) => ReviewState, debounce = false) => {
      const next = { ...fn(current.current), submittedAt: null };
      commit(next);
      persist(next, debounce);
    },
    [commit, persist],
  );

  const add = useCallback(
    (draft: CommentDraft, body: string) => {
      const now = new Date().toISOString();
      const comment: ReviewComment = { id: newId(), ...draft, body, createdAt: now, updatedAt: now };
      change((prev) => ({ ...prev, comments: [...prev.comments, comment] }));
    },
    [change],
  );

  const update = useCallback(
    (id: string, body: string) =>
      change((prev) => ({
        ...prev,
        comments: prev.comments.map((c) =>
          c.id === id ? { ...c, body, updatedAt: new Date().toISOString() } : c,
        ),
      })),
    [change],
  );

  const remove = useCallback(
    (id: string) => change((prev) => ({ ...prev, comments: prev.comments.filter((c) => c.id !== id) })),
    [change],
  );

  const setSummary = useCallback(
    (summary: string) => change((prev) => ({ ...prev, summary }), true),
    [change],
  );

  const setVerdict = useCallback(
    (verdict: ReviewVerdict) => change((prev) => ({ ...prev, verdict })),
    [change],
  );

  const submit = useCallback(() => {
    const next = { ...current.current, submittedAt: new Date().toISOString() };
    commit(next);
    persist(next, false);
  }, [commit, persist]);

  const byPath = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of state.comments) {
      const list = map.get(c.path) ?? [];
      list.push(c);
      map.set(c.path, list);
    }
    return map;
  }, [state.comments]);

  return { ready, state, error, add, update, remove, setSummary, setVerdict, submit, byPath };
}

/** Fire and forget: losing a reading event is cheaper than blocking on it. */
export function recordTelemetry(event: TelemetryEvent): void {
  void fetch("/api/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => {});
}

/** "L12" or "L12–18", with the side spelled out for removed lines. */
export function lineLabel(c: { side: "base" | "head"; line: number | null; endLine: number | null }): string {
  if (c.line === null) return "file";
  const range = c.endLine && c.endLine !== c.line ? `L${c.line}–${c.endLine}` : `L${c.line}`;
  return c.side === "base" ? `${range} (old)` : range;
}
