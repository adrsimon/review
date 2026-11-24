import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type {
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspPosition,
  LspServerStatus,
  LspSymbol,
} from "./types.ts";

/**
 * Just enough of a language client to answer questions about a diff.
 *
 * The viewer never edits, so the document story is one-way: a file is opened from
 * disk the first time someone asks about it, and re-sent whole whenever the
 * watcher says it moved. Nothing here tries to be an editor.
 *
 * Which servers exist is a registry, not a protocol: the point is to match the
 * toolchain of the repo being read rather than to support everything. Today
 * that means TypeScript and Biome, which is what dust runs; rust-analyzer is
 * listed so a Rust checkout picks it up when one is on the PATH.
 */

type Role = "hover" | "definition" | "references" | "symbols" | "diagnostics";

interface ServerSpec {
  id: string;
  extensions: string[];
  /**
   * What we are willing to ask this server, regardless of what it advertises.
   * Biome answers textDocument/definition, for instance, but it is a linter:
   * its answer is not the one anybody clicking a symbol is asking for.
   */
  roles: Role[];
  /**
   * Path inside the repo to prefer over the PATH copy. A repo's own toolchain
   * is the one whose answers match its CI, and for a monorepo it is often the
   * only copy that exists.
   */
  local?: string;
  /**
   * Files that mark the root of a project this server can load. A monorepo has
   * no single one: dust has a tsconfig.json per package and none at the top, so
   * a server rooted at the repository loads nothing and answers nothing.
   */
  markers?: string[];
  bin: string;
  args: string[];
  initializationOptions?: unknown;
  /** Sent as workspace/didChangeConfiguration and answered to workspace/configuration. */
  settings?: unknown;
}

const REGISTRY: ServerSpec[] = [
  {
    id: "tsgo",
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    roles: ["hover", "definition", "references", "symbols", "diagnostics"],
    local: "node_modules/.bin/tsgo",
    markers: ["tsconfig.json", "jsconfig.json"],
    bin: "tsgo",
    args: ["--lsp", "-stdio"],
  },
  {
    id: "biome",
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css"],
    roles: ["diagnostics"],
    local: "node_modules/.bin/biome",
    markers: ["biome.json", "biome.jsonc"],
    bin: "biome",
    args: ["lsp-proxy"],
  },
  {
    id: "rust-analyzer",
    extensions: ["rs"],
    roles: ["hover", "definition", "references", "symbols", "diagnostics"],
    markers: ["Cargo.toml"],
    bin: "rust-analyzer",
    args: [],
  },
];

const LANGUAGE_ID: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  rs: "rust",
};

const SYMBOL_KIND = [
  "file", "module", "namespace", "package", "class", "method", "property", "field",
  "constructor", "enum", "interface", "function", "variable", "constant", "string",
  "number", "boolean", "array", "object", "key", "null", "enum member", "struct",
  "event", "operator", "type parameter",
];

const SEVERITY = ["error", "error", "warning", "info", "hint"] as const;

const REQUEST_TIMEOUT_MS = 20000;
/** A cold tsgo has a whole monorepo to load before it answers anything. */
const READY_TIMEOUT_MS = 90000;

function extensionOf(filePath: string): string {
  const name = filePath.split("/").pop() || "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

/* -------------------------------------------------------------------- client */

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class Client {
  readonly id: string;
  readonly spec: ServerSpec;
  readonly command: string;
  private readonly root: string;
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** uri -> document version already sent. */
  private readonly opened = new Map<string, number>();
  /** Diagnostics a server pushed at us, for the ones that do not support pull. */
  private readonly pushed = new Map<string, LspDiagnostic[]>();
  /** Open documents whose bytes moved on disk, resent on the next question. */
  private readonly dirty = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  capabilities: Record<string, unknown> = {};
  state: LspServerStatus["state"] = "idle";
  error: string | null = null;
  private ready: Promise<void> | null = null;

  constructor(spec: ServerSpec, command: string, root: string) {
    this.id = spec.id;
    this.spec = spec;
    this.command = command;
    this.root = root;
  }

  /** Start on first use, and never start twice. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.boot().catch((err: Error) => {
      this.state = "failed";
      this.error = err.message;
      throw err;
    });
    return this.ready;
  }

  private async boot(): Promise<void> {
    this.state = "starting";
    const proc = spawn(this.command, this.spec.args, {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = proc;
    proc.on("error", (err) => this.die(err.message));
    proc.on("exit", (code) => this.die(`exited with code ${code ?? "null"}`));
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // Server chatter on stderr is not ours to relay, but a crash message is the
    // only explanation we will ever get, so keep the tail of it.
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
      this.error = stderr.trim() || this.error;
    });

    const result = (await this.request("initialize", {
      processId: process.pid,
      rootPath: this.root,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      initializationOptions: this.spec.initializationOptions,
      capabilities: CLIENT_CAPABILITIES,
    }, READY_TIMEOUT_MS)) as { capabilities?: Record<string, unknown> };

    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.spec.settings !== undefined) {
      this.notify("workspace/didChangeConfiguration", { settings: this.spec.settings });
    }
    this.state = "ready";
    this.error = null;
  }

  private die(reason: string): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.error = this.error || reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.id}: ${reason}`));
    }
    this.pending.clear();
    this.opened.clear();
  }

  /* ------------------------------------------------------------ transport */

  private write(message: unknown): void {
    const body = JSON.stringify(message);
    this.proc?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = this.buffer.subarray(0, split).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header: there is no way to find the next frame boundary.
        this.buffer = this.buffer.subarray(split + 4);
        continue;
      }
      const length = Number(match[1]);
      const end = split + 4 + length;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(split + 4, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // A frame we cannot parse is a frame we cannot act on.
      }
    }
  }

  private dispatch(message: Record<string, any>): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "lsp error"));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri as string | undefined;
      if (!uri) return;
      const items = (message.params.diagnostics ?? []) as any[];
      this.pushed.set(uri, items.map((d) => this.toDiagnostic(d)));
      const waiting = this.waiters.get(uri);
      if (waiting) {
        this.waiters.delete(uri);
        for (const resolve of waiting) resolve();
      }
      return;
    }

    // Server-to-client requests. We implement none of them, but a request left
    // unanswered wedges servers that wait on it, so everything gets a reply.
    if (message.id !== undefined && message.method !== undefined) {
      const result =
        message.method === "workspace/configuration"
          ? ((message.params?.items ?? []) as unknown[]).map(() => this.spec.settings ?? {})
          : null;
      this.write({ jsonrpc: "2.0", id: message.id, result });
    }
  }

  request(method: string, params: unknown, timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.state === "failed") return Promise.reject(new Error(this.error || `${this.id} is down`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.id}: ${method} timed out`));
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  supports(capability: string): boolean {
    const value = this.capabilities[capability];
    return value !== undefined && value !== false && value !== null;
  }

  /** Both willing (registry) and able (capabilities). */
  does(role: Role): boolean {
    if (!this.spec.roles.includes(role)) return false;
    const capability = {
      hover: "hoverProvider",
      definition: "definitionProvider",
      references: "referencesProvider",
      symbols: "workspaceSymbolProvider",
      diagnostics: "diagnosticProvider",
    }[role];
    // A push-only server does diagnostics without advertising a provider.
    if (role === "diagnostics") return true;
    return this.supports(capability);
  }

  /* ------------------------------------------------------------ documents */

  /** Make sure the server has this file's current bytes, then leave it open. */
  async open(absolute: string, text: string): Promise<void> {
    await this.start();
    const uri = pathToFileURL(absolute).href;
    const version = this.opened.get(uri);
    if (version === undefined) {
      this.opened.set(uri, 1);
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: LANGUAGE_ID[extensionOf(absolute)] || "plaintext",
          version: 1,
          text,
        },
      });
      return;
    }
    // Already open: only resend when the watcher marked it dirty.
    if (!this.dirty.has(uri)) return;
    this.dirty.delete(uri);
    const next = version + 1;
    this.opened.set(uri, next);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: next },
      contentChanges: [{ text }],
    });
  }

  /** Called when the worktree moved: the next question re-sends the file. */
  touch(absolute: string): void {
    const uri = pathToFileURL(absolute).href;
    if (this.opened.has(uri)) this.dirty.add(uri);
    this.pushed.delete(uri);
  }

  /**
   * Diagnostics, pulled where the server offers it and taken from the push
   * stream otherwise. Biome only pushes, and pushes once per didOpen, so a
   * first read has to wait for the frame rather than return an empty list.
   */
  async diagnostics(absolute: string): Promise<LspDiagnostic[]> {
    const uri = pathToFileURL(absolute).href;
    if (this.supports("diagnosticProvider")) {
      const result = (await this.request("textDocument/diagnostic", {
        textDocument: { uri },
      })) as { items?: any[]; kind?: string } | null;
      return (result?.items ?? []).map((d) => this.toDiagnostic(d));
    }
    const known = this.pushed.get(uri);
    if (known) return known;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 5000);
      timer.unref();
      const list = this.waiters.get(uri) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(uri, list);
    });
    return this.pushed.get(uri) ?? [];
  }

  private toDiagnostic(d: any): LspDiagnostic {
    const code = d.code ?? d.codeDescription?.href ?? null;
    return {
      start: { line: d.range?.start?.line ?? 0, character: d.range?.start?.character ?? 0 },
      end: { line: d.range?.end?.line ?? 0, character: d.range?.end?.character ?? 0 },
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      message: String(d.message ?? "").trim(),
      code: code === null ? null : String(code),
      server: this.id,
    };
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.notify("shutdown", null);
      this.notify("exit", null);
    } catch {
      // Already gone.
    }
    this.proc.kill();
    this.proc = null;
  }
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    publishDiagnostics: { relatedInformation: false },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: { symbolKind: { valueSet: SYMBOL_KIND.map((_, i) => i + 1) } },
  },
  window: { workDoneProgress: true },
};

/* ---------------------------------------------------------------------- pool */

export interface PoolOptions {
  root: string;
  /**
   * Extra checkouts to look in for a repo-local toolchain, in order. A linked
   * worktree is usually created without installing anything, so the binaries
   * live in the main checkout even though the files being read do not.
   */
  toolRoots?: string[];
  /** Off for a diff whose head side is not what is on disk. */
  enabled: boolean;
  reason: string | null;
}

export class LspPool {
  /**
   * Clients keyed by server and project root. One process per project rather
   * than per repository: a monorepo's packages are separate TypeScript
   * programs, and a server rooted above all of them belongs to none of them.
   */
  private readonly clients = new Map<string, Client>();
  /** Where each server's binary was found, resolved once at construction. */
  private readonly commands = new Map<string, string>();
  /** Memoised project-root walks, keyed by server and directory. */
  private readonly roots = new Map<string, string>();
  private readonly textCache = new Map<string, string>();
  /**
   * Absolute paths outside the repository that a server has pointed at. A
   * definition in TypeScript lands in node_modules often enough that refusing
   * to show it would gut the feature, but the route that reads files is not
   * about to take an arbitrary path from the page either: only what a language
   * server named is readable.
   */
  private readonly blessed = new Set<string>();
  /**
   * File extensions the diff actually contains. A repository-wide question
   * like symbol search has no file to route on, and answering it by starting
   * every server in the registry would boot rust-analyzer to look up a
   * TypeScript name — minutes of indexing for an answer it does not have.
   */
  private active = new Set<string>();
  /** The diff's own file list, which is where a project seed comes from. */
  private readonly observed: string[] = [];

  constructor(private readonly opts: PoolOptions) {
    if (!opts.enabled) return;
    for (const spec of REGISTRY) {
      const command = resolve(spec, ...this.lookup());
      if (command) this.commands.set(spec.id, command);
    }
  }

  /** Where a repo-local binary may live, nearest checkout first. */
  private lookup(): string[] {
    return [this.opts.root, ...(this.opts.toolRoots ?? [])];
  }

  get enabled(): boolean {
    return this.opts.enabled && this.relevantSpecs().length > 0;
  }

  /** Tell the pool which languages are in play, from the diff's own file list. */
  observe(paths: string[]): void {
    for (const filePath of paths) {
      this.active.add(extensionOf(filePath));
      if (this.observed.length < 2000 && !this.observed.includes(filePath)) {
        this.observed.push(filePath);
      }
    }
  }

  /** Running instances of one server, across whichever projects opened it. */
  private instances(id: string): Client[] {
    return [...this.clients.values()].filter((client) => client.spec.id === id);
  }

  /** Servers whose languages appear in the diff, plus any already running. */
  private relevantSpecs(): ServerSpec[] {
    return REGISTRY.filter((spec) => {
      if (!this.commands.has(spec.id)) return false;
      if (this.instances(spec.id).some((c) => c.state === "ready" || c.state === "starting")) {
        return true;
      }
      return spec.extensions.some((ext) => this.active.has(ext));
    });
  }

  /**
   * The nearest enclosing directory that looks like a project for this server,
   * stopping at the repository, which is the fallback for a flat repo or one
   * whose marker lives at the top.
   */
  private projectRoot(spec: ServerSpec, absolute: string): string {
    if (!spec.markers) return this.opts.root;
    const from = path.dirname(absolute);
    const memo = `${spec.id}\u0000${from}`;
    const hit = this.roots.get(memo);
    if (hit) return hit;
    let dir = from;
    let found = this.opts.root;
    for (;;) {
      if (spec.markers.some((marker) => existsSync(path.join(dir, marker)))) {
        found = dir;
        break;
      }
      if (dir === this.opts.root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    this.roots.set(memo, found);
    return found;
  }

  /** The client for one server and one file, started on first use. */
  private client(spec: ServerSpec, absolute: string): Client | null {
    const root = this.projectRoot(spec, absolute);
    const key = `${spec.id}\u0000${root}`;
    const hit = this.clients.get(key);
    if (hit) return hit;
    // A package may carry its own copy of the toolchain; the repository's is
    // the fallback, and PATH the one after that.
    // The same package in the main checkout, which for a worktree is where an
    // install of that package's own toolchain would be.
    const mirrored = this.opts.toolRoots?.map((base) =>
      path.join(base, path.relative(this.opts.root, root)),
    );
    const command =
      resolve(spec, root, ...(mirrored ?? []), ...this.lookup()) ?? this.commands.get(spec.id);
    if (!command) return null;
    const client = new Client(spec, command, root);
    this.clients.set(key, client);
    return client;
  }

  get root(): string {
    return this.opts.root;
  }

  get reason(): string | null {
    if (!this.opts.enabled) return this.opts.reason;
    if (this.commands.size === 0) return "no language server found for this repository";
    if (this.relevantSpecs().length === 0) return "no language server covers the files in this diff";
    return null;
  }

  status(): LspServerStatus[] {
    const relevant = new Set(this.relevantSpecs().map((spec) => spec.id));
    const rows: LspServerStatus[] = [];
    for (const spec of REGISTRY) {
      const command = this.commands.get(spec.id) ?? null;
      const live = this.instances(spec.id);
      // One row per server, not per project: which of a monorepo's packages a
      // process happens to be rooted at is not the reader's problem. The row
      // reports the best state any instance reached, and a server whose
      // language is nowhere in the diff is reported as absent rather than
      // idle, because it is not going to be started at all.
      const best =
        live.find((c) => c.state === "ready") ??
        live.find((c) => c.state === "starting") ??
        live.find((c) => c.state === "failed") ??
        null;
      rows.push({
        id: spec.id,
        command,
        state: !command || !relevant.has(spec.id) ? "missing" : (best?.state ?? "idle"),
        error: best?.error ?? null,
        features: best ? features(best) : [],
        extensions: spec.extensions,
      });
    }
    return rows;
  }

  /** Servers that claim this file, most specific first. */
  private for(absolute: string): Client[] {
    const ext = extensionOf(absolute);
    return REGISTRY.filter((spec) => spec.extensions.includes(ext))
      .map((spec) => this.client(spec, absolute))
      .filter((c): c is Client => !!c && c.state !== "failed");
  }

  /** Absolute path for a repo-relative one, refusing anything that escapes. */
  resolvePath(relative: string): string | null {
    const absolute = path.resolve(this.opts.root, relative);
    if (absolute !== this.opts.root && !absolute.startsWith(this.opts.root + path.sep)) return null;
    return absolute;
  }

  private async text(absolute: string): Promise<string> {
    const hit = this.textCache.get(absolute);
    if (hit !== undefined) return hit;
    const text = await readFile(absolute, "utf8");
    if (this.textCache.size > 200) this.textCache.clear();
    this.textCache.set(absolute, text);
    return text;
  }

  /** Open a file on every server that wants it, ignoring the ones that fail. */
  private async ensure(relative: string): Promise<{ absolute: string; clients: Client[] }> {
    const absolute = this.resolvePath(relative);
    if (!absolute) throw new Error("path outside the repository");
    const clients = this.for(absolute);
    if (clients.length === 0) throw new Error("no language server for this file type");
    const text = await this.text(absolute);
    const live: Client[] = [];
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.open(absolute, text);
          live.push(client);
        } catch {
          // A server that will not start is one the others cover for.
        }
      }),
    );
    return { absolute, clients: live };
  }

  /** The worktree moved: drop cached text and mark the file dirty everywhere. */
  invalidate(relative: string): void {
    const absolute = this.resolvePath(relative);
    if (!absolute) return;
    this.textCache.delete(absolute);
    for (const client of this.clients.values()) client.touch(absolute);
  }

  async hover(relative: string, position: LspPosition): Promise<LspHover | null> {
    const { absolute, clients } = await this.ensure(relative);
    const uri = pathToFileURL(absolute).href;
    for (const client of clients) {
      if (!client.does("hover")) continue;
      const result = (await client
        .request("textDocument/hover", { textDocument: { uri }, position })
        .catch(() => null)) as any;
      const markdown = renderHover(result?.contents);
      if (!markdown) continue;
      return {
        markdown,
        server: client.id,
        start: result.range?.start ?? null,
        end: result.range?.end ?? null,
      };
    }
    return null;
  }

  async definition(relative: string, position: LspPosition): Promise<LspLocation[]> {
    return this.locations(relative, position, "textDocument/definition", {});
  }

  async references(relative: string, position: LspPosition): Promise<LspLocation[]> {
    return this.locations(relative, position, "textDocument/references", {
      context: { includeDeclaration: false },
    });
  }

  private async locations(
    relative: string,
    position: LspPosition,
    method: string,
    extra: Record<string, unknown>,
  ): Promise<LspLocation[]> {
    const { absolute, clients } = await this.ensure(relative);
    const uri = pathToFileURL(absolute).href;
    const role = method === "textDocument/definition" ? "definition" : "references";
    for (const client of clients) {
      if (!client.does(role)) continue;
      const result = (await client
        .request(method, { textDocument: { uri }, position, ...extra })
        .catch(() => null)) as any;
      const raw = Array.isArray(result) ? result : result ? [result] : [];
      if (raw.length === 0) continue;
      return this.decorate(raw.map((item) => this.toLocation(item)).filter((l): l is LspLocation => !!l));
    }
    return [];
  }

  /**
   * One file per project this server would claim, which is what a workspace
   * symbol index has to be built from. Capped: a monorepo diff can touch six
   * packages, and six cold TypeScript programs to answer one lookup is a worse
   * deal than an answer drawn from the handful the reader is actually in.
   */
  private seeds(spec: ServerSpec, limit = 4): string[] {
    const byRoot = new Map<string, string>();
    for (const filePath of this.observed) {
      if (!spec.extensions.includes(extensionOf(filePath))) continue;
      const absolute = this.resolvePath(filePath);
      if (!absolute) continue;
      const root = this.projectRoot(spec, absolute);
      if (!byRoot.has(root)) byRoot.set(root, filePath);
      if (byRoot.size >= limit) break;
    }
    return [...byRoot.values()];
  }

  async symbols(query: string, limit = 60): Promise<LspSymbol[]> {
    const out: LspSymbol[] = [];
    for (const spec of this.relevantSpecs()) {
      if (!spec.roles.includes("symbols")) continue;
      // A workspace symbol index is built from a loaded project, and a project
      // is loaded from an open file. Asking a server that has been told about
      // nothing returns nothing, however well it knows the repository.
      const clients: Client[] = [];
      for (const seed of this.seeds(spec)) {
        const opened = await this.ensure(seed).catch(() => null);
        if (!opened) continue;
        for (const client of opened.clients) {
          if (client.spec.id === spec.id && client.does("symbols") && !clients.includes(client)) {
            clients.push(client);
          }
        }
      }
      const answers = await Promise.all(
        clients.map((client) =>
          client.request("workspace/symbol", { query }).catch(() => null) as Promise<any>,
        ),
      );
      const seen = new Set<string>();
      for (const result of answers) {
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        for (const item of items) {
          const location = this.toLocation(item.location ?? item);
          if (!location) continue;
          // Packages share files through path aliases, so two projects can
          // name the same declaration.
          const identity = `${location.path}:${location.start.line}:${item.name}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          out.push({
            name: String(item.name ?? ""),
            kind: SYMBOL_KIND[(item.kind ?? 1) - 1] ?? "symbol",
            container: item.containerName ? String(item.containerName) : null,
            location,
          });
        }
      }
      // The first server with an answer wins: merging two rankings produces a
      // list that is ordered by neither.
      if (out.length > 0) break;
    }
    // Repo files first: a hit in node_modules is rarely what was meant.
    out.sort((a, b) => Number(a.location.external) - Number(b.location.external));
    return this.decorateSymbols(out.slice(0, limit));
  }

  async diagnostics(relative: string): Promise<LspDiagnostic[]> {
    const { clients } = await this.ensure(relative);
    const absolute = this.resolvePath(relative)!;
    const lists = await Promise.all(
      clients
        .filter((client) => client.does("diagnostics"))
        .map((client) => client.diagnostics(absolute).catch(() => [] as LspDiagnostic[])),
    );
    const all = lists.flat();
    // Two servers reporting the same thing is common enough to be worth folding.
    const seen = new Set<string>();
    return all.filter((d) => {
      const key = `${d.start.line}:${d.start.character}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private toLocation(item: any): LspLocation | null {
    const uri: string | undefined = item?.uri ?? item?.targetUri;
    const range = item?.range ?? item?.targetSelectionRange ?? item?.targetRange;
    if (!uri || !range) return null;
    let absolute: string;
    try {
      absolute = fileURLToPath(uri);
    } catch {
      return null;
    }
    const inside = absolute.startsWith(this.opts.root + path.sep);
    if (!inside) this.blessed.add(absolute);
    return {
      path: inside ? path.relative(this.opts.root, absolute) : absolute,
      external: !inside,
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
      preview: null,
    };
  }

  /** Fill in each hit's line of source, so a result list stands on its own. */
  private async decorate(locations: LspLocation[]): Promise<LspLocation[]> {
    await Promise.all(
      locations.map(async (location) => {
        const absolute = location.external
          ? location.path
          : path.join(this.opts.root, location.path);
        try {
          const text = await this.text(absolute);
          location.preview = text.split("\n")[location.start.line]?.trim().slice(0, 200) ?? null;
        } catch {
          location.preview = null;
        }
      }),
    );
    return locations;
  }

  private async decorateSymbols(symbols: LspSymbol[]): Promise<LspSymbol[]> {
    await this.decorate(symbols.map((s) => s.location));
    return symbols;
  }

  /** Whether an absolute path outside the repo is one a server pointed at. */
  canRead(absolute: string): boolean {
    return this.blessed.has(absolute);
  }

  stop(): void {
    for (const client of this.clients.values()) client.stop();
  }
}

function features(client: Client): string[] {
  if (client.state !== "ready") return [];
  return (["hover", "definition", "references", "symbols", "diagnostics"] as const).filter((role) =>
    client.does(role),
  );
}

function resolve(spec: ServerSpec, ...roots: string[]): string | null {
  if (spec.local) {
    for (const root of roots) {
      const local = path.join(root, spec.local);
      if (existsSync(local)) return local;
    }
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, spec.bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** LSP hover contents come in three shapes, all of which render as markdown. */
function renderHover(contents: unknown): string | null {
  if (!contents) return null;
  if (typeof contents === "string") return contents.trim() || null;
  if (Array.isArray(contents)) {
    const parts = contents.map((c) => renderHover(c)).filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  }
  const record = contents as { value?: string; language?: string; kind?: string };
  if (typeof record.value !== "string") return null;
  const value = record.value.trim();
  if (!value) return null;
  if (record.language) return "```" + record.language + "\n" + value + "\n```";
  return value;
}
