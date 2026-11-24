import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffFile, LspDiagnostic, LspStatus } from "../../../src/types.ts";
import { fetchDiagnostics } from "./lsp.ts";

/**
 * Diagnostics for the files on screen.
 *
 * Keyed by patch hash rather than path, so a live update refetches exactly the
 * files that moved and nothing else, and so a file that comes back unchanged
 * costs nothing. Requests are kept to a few at a time: a cold language server
 * asked about forty files at once answers none of them quickly.
 */

const CONCURRENCY = 4;

function key(file: DiffFile): string {
  return `${file.hash}:${file.path}`;
}

/** Extensions any running server claims, so we do not ask about a .md file. */
function servedExtensions(status: LspStatus | null): Set<string> | null {
  if (!status?.enabled) return null;
  const out = new Set<string>();
  for (const server of status.servers) {
    if (server.state === "missing" || server.state === "failed") continue;
    for (const ext of server.extensions) out.add(ext);
  }
  return out;
}

export interface Diagnostics {
  for: (file: DiffFile) => LspDiagnostic[];
  /** True while at least one file is still being asked about. */
  loading: boolean;
}

export function useDiagnostics(
  files: DiffFile[],
  status: LspStatus | null,
  /** Skip files the reader has collapsed away; they have nothing to mark up. */
  wanted: (file: DiffFile) => boolean,
): Diagnostics {
  const [byKey, setByKey] = useState<Map<string, LspDiagnostic[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;

  useEffect(() => {
    const extensions = servedExtensions(status);
    if (!extensions) return;
    let live = true;

    const queue = files.filter((file) => {
      if (file.binary || file.image || file.status === "deleted") return false;
      const name = file.path.split("/").pop() || "";
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
      if (!extensions.has(ext)) return false;
      return wantedRef.current(file);
    });
    if (queue.length === 0) return;

    setLoading(true);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue[next++];
        if (!file || !live) return;
        const diagnostics = await fetchDiagnostics(file.path, file.hash);
        if (!live) return;
        setByKey((prev) => {
          if (prev.has(key(file))) return prev;
          const copy = new Map(prev);
          copy.set(key(file), diagnostics);
          return copy;
        });
      }
    };
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      if (live) setLoading(false);
    });

    return () => {
      live = false;
    };
  }, [files, status]);

  const lookup = useCallback((file: DiffFile) => byKey.get(key(file)) ?? EMPTY, [byKey]);
  return { for: lookup, loading };
}

const EMPTY: LspDiagnostic[] = [];
