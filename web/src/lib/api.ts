import type { DiffEvent, DiffFile, DiffPayload } from "../../../src/types.ts";

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export function fetchDiff(): Promise<DiffPayload> {
  return json<DiffPayload>("/api/diff");
}

export function fetchCommit(sha: string): Promise<DiffPayload> {
  return json<DiffPayload>(`/api/commit/${sha}`);
}

export function fetchFile(path: string): Promise<DiffFile> {
  return json<{ file: DiffFile }>(`/api/diff?path=${encodeURIComponent(path)}`).then((r) => r.file);
}

const fileCache = new Map<string, Promise<string[] | null>>();

export function fetchFileLines(path: string, side: "base" | "head"): Promise<string[] | null> {
  const key = `${side}:${path}`;
  let pending = fileCache.get(key);
  if (!pending) {
    pending = json<{ lines: string[] | null }>(
      `/api/file?side=${side}&path=${encodeURIComponent(path)}`,
    ).then((r) => r.lines);
    fileCache.set(key, pending);
  }
  return pending;
}

export function blobUrl(path: string, side: "base" | "head"): string {
  return `/api/blob?side=${side}&path=${encodeURIComponent(path)}`;
}

/**
 * Subscribe to worktree changes. The open stream doubles as the liveness signal
 * the server uses to decide when to exit, so this runs for the life of the page.
 * EventSource reconnects on its own, and the server's grace window covers the gap.
 */
export function subscribe(onEvent: (event: DiffEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as DiffEvent);
    } catch {
      // A truncated frame is not worth tearing the stream down for.
    }
  };
  return () => source.close();
}

/** Expanded context is keyed by revision, so a changed worktree invalidates it. */
export function clearFileCache(path?: string): void {
  if (!path) return fileCache.clear();
  for (const key of Array.from(fileCache.keys())) {
    if (key.endsWith(`:${path}`)) fileCache.delete(key);
  }
}
