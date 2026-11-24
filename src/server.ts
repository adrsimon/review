import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitDiff,
  commits,
  diffFiles,
  fileBlob,
  fileLines,
  mainWorktree,
  resolveCommit,
  type Side,
} from "./git.ts";
import type { DiffEvent, DiffFile, DiffPayload, FileStamp, LspStatus, Revs } from "./types.ts";
import type { TrainingSession } from "./training.ts";
import { watchRepo } from "./watch.ts";
import { attribute, buildIndex, type Index } from "./provenance.ts";
import { LspPool } from "./lsp.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  cwd: string;
  revs: Revs;
  untracked: boolean;
  port: number;
  /** Exit once every browser tab is gone. */
  autoExit: boolean;
  /** Follow the worktree and push changes. Off for a fixed commit range. */
  live: boolean;
  /** Read agent session transcripts to caption hunks. */
  provenance: boolean;
  /** Answer language questions from the repository's own language servers. */
  lsp: boolean;
  /** A review-training session: shows the PR, takes comments, records reading. */
  training?: TrainingSession | null;
}

export interface RunningServer {
  url: string;
  close: () => void;
}

const CLIENT_TIMEOUT_MS = 15000;
const FIRST_CONNECT_GRACE_MS = 120000;

function stamp(file: DiffFile): FileStamp {
  return {
    path: file.path,
    hash: file.hash,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function isImage(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(p);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { cwd, revs } = opts;
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");

  // The join is textual, so it works on a commit range as readily as on the
  // worktree: a range with no matching session simply gets no captions.
  let index: Index = opts.provenance ? await buildIndex(cwd) : { steps: [] };

  const files = await diffFiles(cwd, revs, { untracked: opts.untracked });
  attribute(files, index);
  const commitList = await commits(cwd, revs);
  const payload: DiffPayload = {
    version: 1,
    repo: path.basename(cwd),
    revs,
    files,
    commits: commitList,
    commit: null,
    truncated: false,
    training: opts.training?.info ?? null,
  };

  // Language answers come from the files on disk, so they are only honest when
  // the head side of the diff is what is on disk. A range whose head is HEAD
  // still qualifies: the worktree is that commit plus whatever is uncommitted.
  let lspReason: string | null = null;
  let lspOk = opts.lsp;
  if (opts.lsp && revs.mode === "range") {
    const head = await resolveCommit(cwd, "HEAD").catch(() => null);
    if (head !== revs.head) {
      lspOk = false;
      lspReason = "language answers come from the worktree, which is not this range's head";
    }
  }
  if (!opts.lsp) lspReason = "disabled with --no-lsp";
  const main = opts.lsp ? await mainWorktree(cwd) : null;
  const lsp = new LspPool({
    root: cwd,
    toolRoots: main && main !== cwd ? [main] : [],
    enabled: lspOk,
    reason: lspReason,
  });
  lsp.observe(files.map((f) => f.path));

  let lastSeen = 0;
  let sawClient = false;
  const startedAt = Date.now();

  const listeners = new Set<ServerResponse>();

  /**
   * Recompute the diff and tell the page what moved. Runs are never overlapped:
   * a trigger during a run sets `again`, so a burst of writes costs one extra
   * pass rather than one pass per event.
   */
  let running = false;
  let again = false;
  async function refresh(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        // The session keeps writing, so the index is rebuilt alongside the diff.
        if (opts.provenance) index = await buildIndex(cwd);
        const next = await diffFiles(cwd, revs, { untracked: opts.untracked });
        attribute(next, index);
        const before = new Map(payload.files.map((f) => [f.path, f.hash]));
        const after = new Map(next.map((f) => [f.path, f.hash]));
        const changed = next.filter((f) => before.get(f.path) !== f.hash);
        const removed = payload.files.filter((f) => !after.has(f.path)).map((f) => f.path);
        if (changed.length === 0 && removed.length === 0) continue;
        lsp.observe(next.map((f) => f.path));
        for (const file of changed) lsp.invalidate(file.path);
        for (const file of removed) lsp.invalidate(file);
        payload.version += 1;
        payload.files = next;
        if (revs.mode === "range") payload.commits = await commits(cwd, revs);
        const event: DiffEvent = {
          version: payload.version,
          stamps: changed.map(stamp),
          removed,
        };
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        for (const res of listeners) res.write(frame);
      } while (again);
    } catch {
      // A diff mid-write can fail; the next trigger picks it up.
    } finally {
      running = false;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      sendJson(res, 500, { error: err.message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname;

    if (route === "/api/diff") {
      lastSeen = Date.now();
      sawClient = true;
      const only = url.searchParams.get("path");
      if (only) {
        const file = payload.files.find((f) => f.path === only);
        if (!file) {
          sendJson(res, 404, { error: "no such file in the diff" });
          return;
        }
        sendJson(res, 200, { version: payload.version, file });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    // The open stream is also the liveness signal, so there is no ping route.
    if (route === "/api/events") {
      lastSeen = Date.now();
      sawClient = true;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`retry: 1000\n\n`);
      listeners.add(res);
      const keepAlive = setInterval(() => {
        lastSeen = Date.now();
        res.write(": ping\n\n");
      }, 5000);
      keepAlive.unref();
      req.on("close", () => {
        clearInterval(keepAlive);
        listeners.delete(res);
        lastSeen = Date.now();
      });
      return;
    }

    if (route.startsWith("/api/commit/")) {
      const sha = route.slice("/api/commit/".length);
      if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
        sendJson(res, 400, { error: "bad sha" });
        return;
      }
      const commitFiles = await commitDiff(cwd, sha);
      commitFiles.sort((a, b) => a.path.localeCompare(b.path));
      sendJson(res, 200, { ...payload, files: commitFiles, commit: sha });
      return;
    }

    if (route === "/api/review" || route === "/api/telemetry") {
      await handleTraining(route, req, res);
      return;
    }

    if (route.startsWith("/api/lsp")) {
      lastSeen = Date.now();
      await handleLsp(route, url, res);
      return;
    }

    // Definitions and references land wherever the symbol lives, which is
    // routinely a file the diff never mentions.
    if (route === "/api/source") {
      const filePath = url.searchParams.get("path");
      const absolute = filePath
        ? path.isAbsolute(filePath)
          ? lsp.canRead(filePath)
            ? filePath
            : null
          : sourcePath(cwd, filePath)
        : null;
      if (!absolute) {
        sendJson(res, 404, { error: "no such file" });
        return;
      }
      try {
        const text = await readFile(absolute, "utf8");
        sendJson(res, 200, { path: filePath, lines: text.replace(/\n$/, "").split("\n") });
      } catch {
        sendJson(res, 404, { error: "no such file" });
      }
      return;
    }

    if (route === "/api/file") {
      const filePath = url.searchParams.get("path");
      const side = (url.searchParams.get("side") || "head") as Side;
      if (!filePath) {
        sendJson(res, 400, { error: "path required" });
        return;
      }
      const lines = await fileLines(cwd, revs, side, filePath);
      sendJson(res, 200, { lines });
      return;
    }

    if (route === "/api/blob") {
      const filePath = url.searchParams.get("path");
      const side = (url.searchParams.get("side") || "head") as Side;
      if (!filePath || !isImage(filePath)) {
        res.writeHead(404).end();
        return;
      }
      const buf = await fileBlob(cwd, revs, side, filePath);
      if (!buf) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(buf);
      return;
    }

    await serveStatic(route, res, webRoot);
  }

  async function handleTraining(
    route: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const training = opts.training;
    if (!training) {
      sendJson(res, 404, { error: "not a training session" });
      return;
    }
    if (route === "/api/review" && req.method === "GET") {
      sendJson(res, 200, training.review());
      return;
    }
    if (req.method !== "POST" && req.method !== "PUT") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    // A JSON content type cannot be sent cross-origin without a preflight this
    // server never answers, so another tab cannot write to the review.
    if (!(req.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(res, 415, { error: "expected application/json" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "bad json" });
      return;
    }
    if (route === "/api/review") {
      sendJson(res, 200, await training.saveReview(body));
      return;
    }
    await training.record(body);
    sendJson(res, 200, { ok: true });
  }

  async function handleLsp(route: string, url: URL, res: ServerResponse): Promise<void> {
    if (route === "/api/lsp/status") {
      const status: LspStatus = {
        enabled: lsp.enabled,
        reason: lsp.reason,
        root: lsp.root,
        servers: lsp.status(),
      };
      sendJson(res, 200, status);
      return;
    }
    if (!lsp.enabled) {
      sendJson(res, 409, { error: lsp.reason || "language servers are not available" });
      return;
    }

    if (route === "/api/lsp/symbols") {
      const query = url.searchParams.get("q") || "";
      sendJson(res, 200, { symbols: await lsp.symbols(query) });
      return;
    }

    const filePath = url.searchParams.get("path");
    if (!filePath) {
      sendJson(res, 400, { error: "path required" });
      return;
    }

    try {
      if (route === "/api/lsp/diagnostics") {
        sendJson(res, 200, { diagnostics: await lsp.diagnostics(filePath) });
        return;
      }
      const position = {
        line: Number(url.searchParams.get("line")),
        character: Number(url.searchParams.get("character")),
      };
      if (!Number.isInteger(position.line) || !Number.isInteger(position.character)) {
        sendJson(res, 400, { error: "line and character required" });
        return;
      }
      if (route === "/api/lsp/hover") {
        sendJson(res, 200, { hover: await lsp.hover(filePath, position) });
        return;
      }
      if (route === "/api/lsp/definition") {
        sendJson(res, 200, { locations: await lsp.definition(filePath, position) });
        return;
      }
      if (route === "/api/lsp/references") {
        sendJson(res, 200, { locations: await lsp.references(filePath, position) });
        return;
      }
    } catch (err) {
      // A language server that is slow, cold or missing is a degraded feature,
      // not a broken page: say so and let the UI keep its shape.
      sendJson(res, 200, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    sendJson(res, 404, { error: "no such route" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const url = `http://127.0.0.1:${port}`;

  let timer: NodeJS.Timeout | undefined;
  if (opts.autoExit) {
    timer = setInterval(() => {
      const now = Date.now();
      if (!sawClient) {
        if (now - startedAt > FIRST_CONNECT_GRACE_MS) process.exit(0);
        return;
      }
      if (listeners.size > 0) return;
      if (now - lastSeen > CLIENT_TIMEOUT_MS) process.exit(0);
    }, 3000);
    timer.unref();
  }

  const watcher = opts.live ? watchRepo(cwd, () => void refresh()) : null;

  return {
    url,
    close: () => {
      if (timer) clearInterval(timer);
      lsp.stop();
      watcher?.close();
      for (const res of listeners) res.end();
      server.close();
    },
  };
}

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A repo file by its repo-relative path, refusing anything that escapes. */
function sourcePath(cwd: string, relative: string): string | null {
  if (path.isAbsolute(relative)) return null;
  const absolute = path.resolve(cwd, relative);
  return absolute.startsWith(cwd + path.sep) ? absolute : null;
}

async function serveStatic(route: string, res: ServerResponse, webRoot: string): Promise<void> {
  const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
  const target = path.join(webRoot, rel);
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error("directory");
    const buf = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    });
    res.end(buf);
  } catch {
    try {
      const html = await readFile(path.join(webRoot, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(html);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("UI not built. Run `bun run build` in this checkout.");
    }
  }
}
