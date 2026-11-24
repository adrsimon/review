import { useEffect, useState } from "react";
import type {
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspPosition,
  LspStatus,
  LspSymbol,
} from "../../../src/types.ts";

/**
 * The language half of the API. Everything here is best effort: a server that
 * is missing, cold or slow degrades a feature rather than breaking the page, so
 * failures resolve to null or an empty list instead of throwing.
 */

async function ask<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    const body = (await res.json()) as T & { error?: string };
    if (body && typeof body === "object" && "error" in body && body.error) return fallback;
    return body;
  } catch {
    return fallback;
  }
}

function at(path: string, position: LspPosition): string {
  return `path=${encodeURIComponent(path)}&line=${position.line}&character=${position.character}`;
}

export function fetchLspStatus(): Promise<LspStatus | null> {
  return ask<LspStatus | null>("/api/lsp/status", null);
}

export async function fetchHover(path: string, position: LspPosition): Promise<LspHover | null> {
  const body = await ask<{ hover: LspHover | null }>(`/api/lsp/hover?${at(path, position)}`, {
    hover: null,
  });
  return body.hover;
}

export async function fetchDefinition(
  path: string,
  position: LspPosition,
): Promise<LspLocation[]> {
  const body = await ask<{ locations: LspLocation[] }>(`/api/lsp/definition?${at(path, position)}`, {
    locations: [],
  });
  return body.locations ?? [];
}

export async function fetchReferences(
  path: string,
  position: LspPosition,
): Promise<LspLocation[]> {
  const body = await ask<{ locations: LspLocation[] }>(`/api/lsp/references?${at(path, position)}`, {
    locations: [],
  });
  return body.locations ?? [];
}

export async function fetchSymbols(query: string): Promise<LspSymbol[]> {
  const body = await ask<{ symbols: LspSymbol[] }>(
    `/api/lsp/symbols?q=${encodeURIComponent(query)}`,
    { symbols: [] },
  );
  return body.symbols ?? [];
}

/**
 * Diagnostics for one file, cached until the file's hash moves. Keying on the
 * hash rather than the path is what makes a live update refetch exactly the
 * files that changed, the same rule the diff and viewed state already follow.
 */
const diagnosticCache = new Map<string, Promise<LspDiagnostic[]>>();

export function fetchDiagnostics(path: string, hash: string): Promise<LspDiagnostic[]> {
  const key = `${hash}:${path}`;
  let pending = diagnosticCache.get(key);
  if (!pending) {
    pending = ask<{ diagnostics: LspDiagnostic[] }>(
      `/api/lsp/diagnostics?path=${encodeURIComponent(path)}`,
      { diagnostics: [] },
    ).then((body) => rank(body.diagnostics ?? []));
    if (diagnosticCache.size > 300) diagnosticCache.clear();
    diagnosticCache.set(key, pending);
  }
  return pending;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, hint: 3 } as const;

/**
 * tsgo reports an unused binding as a hint on the same span biome reports a
 * lint error on, so a naive merge says everything twice. A hint that shares a
 * line with something louder adds nothing, and the rest sort by severity.
 */
function rank(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  const loud = new Set(
    diagnostics.filter((d) => d.severity !== "hint").map((d) => d.start.line),
  );
  return diagnostics
    .filter((d) => d.severity !== "hint" || !loud.has(d.start.line))
    .sort(
      (a, b) =>
        a.start.line - b.start.line || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
}

/** Any repo file, so a definition can be read without it being in the diff. */
const sourceCache = new Map<string, Promise<string[] | null>>();

export function fetchSource(path: string): Promise<string[] | null> {
  let pending = sourceCache.get(path);
  if (!pending) {
    pending = ask<{ lines: string[] | null }>(
      `/api/source?path=${encodeURIComponent(path)}`,
      { lines: null },
    ).then((body) => body.lines);
    sourceCache.set(path, pending);
  }
  return pending;
}

export function clearSourceCache(): void {
  sourceCache.clear();
  diagnosticCache.clear();
}

/** Whether language answers are available at all, asked once per page. */
export function useLspStatus(): LspStatus | null {
  const [status, setStatus] = useState<LspStatus | null>(null);
  useEffect(() => {
    void fetchLspStatus().then(setStatus);
  }, []);
  return status;
}
