#!/usr/bin/env bun
// @bun

// src/cli.ts
import { spawn as spawn2 } from "child_process";

// src/git.ts
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { createHash as createHash2 } from "crypto";
import path from "path";
import { promisify } from "util";

// src/parse.ts
import { createHash } from "crypto";
var IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
function unquotePath(raw) {
  if (!raw.startsWith('"'))
    return raw;
  const body = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0;i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[++i];
    if (next >= "0" && next <= "7") {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else if (next === "n")
      bytes.push(10);
    else if (next === "t")
      bytes.push(9);
    else if (next === "r")
      bytes.push(13);
    else
      bytes.push(next.charCodeAt(0));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
function parseGitHeader(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end < 0)
      return null;
    return { a: strip(unquotePath(rest.slice(0, end + 1))), b: strip(unquotePath(rest.slice(end + 2))) };
  }
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  if (a.slice(2) === b.slice(2))
    return { a: strip(a), b: strip(b) };
  const idx = rest.indexOf(" b/");
  if (idx < 0)
    return null;
  return { a: strip(rest.slice(0, idx)), b: strip(rest.slice(idx + 1)) };
}
function findQuoteEnd(s) {
  for (let i = 1;i < s.length; i++) {
    if (s[i] === "\\")
      i++;
    else if (s[i] === '"')
      return i;
  }
  return -1;
}
function strip(p) {
  if (p.startsWith("a/") || p.startsWith("b/"))
    return p.slice(2);
  return p;
}
function hashFile(file) {
  const h = createHash("sha1");
  h.update(file.path);
  h.update(file.status);
  h.update(String(file.binary));
  for (const hunk of file.hunks) {
    h.update(hunk.header);
    h.update(`${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}`);
    for (const line of hunk.lines)
      h.update(line.kind + line.text + `
`);
  }
  return h.digest("hex").slice(0, 16);
}
function parsePatch(patch, maxLinesPerFile = 20000) {
  const files = [];
  const lines = patch.split(`
`);
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const closeFile = () => {
    if (!file)
      return;
    file.large = file.additions + file.deletions > maxLinesPerFile;
    file.hash = hashFile(file);
    files.push(file);
    file = null;
    hunk = null;
  };
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      closeFile();
      const header = parseGitHeader(line);
      const path = header ? header.b : "unknown";
      file = {
        path,
        hash: "",
        oldPath: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        large: false,
        image: IMAGE_EXT.test(path),
        oldTotal: null,
        newTotal: null,
        hunks: []
      };
      if (header && header.a !== header.b)
        file.oldPath = header.a;
      continue;
    }
    if (!file)
      continue;
    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.oldPath = unquotePath(line.slice("rename from ".length));
      file.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = unquotePath(line.slice("rename to ".length));
      file.status = "renamed";
      continue;
    }
    if (line.startsWith("copy from ")) {
      file.oldPath = unquotePath(line.slice("copy from ".length));
      file.status = "copied";
      continue;
    }
    if (line.startsWith("copy to ")) {
      file.path = unquotePath(line.slice("copy to ".length));
      file.status = "copied";
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity index")) {
      continue;
    }
    const m = HUNK_HEADER.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5].trim(),
        lines: []
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk)
      continue;
    if (line.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last)
        last.noNewline = true;
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    let entry = null;
    if (marker === "+") {
      entry = { kind: "add", oldNumber: null, newNumber: newNo++, text };
      file.additions++;
    } else if (marker === "-") {
      entry = { kind: "del", oldNumber: oldNo++, newNumber: null, text };
      file.deletions++;
    } else if (marker === " ") {
      entry = { kind: "context", oldNumber: oldNo++, newNumber: newNo++, text };
    }
    if (entry)
      hunk.lines.push(entry);
  }
  closeFile();
  return files;
}

// src/git.ts
var run = promisify(execFile);
var MAX_BUFFER = 512 * 1024 * 1024;
var NUL = String.fromCharCode(0);
var SEP = String.fromCharCode(31);
var DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--find-copies",
  "-U3",
  "--patch"
];

class GitError extends Error {
}
async function git(cwd, args) {
  try {
    const { stdout } = await run("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8"
    });
    return stdout;
  } catch (err) {
    const e = err;
    throw new GitError((e.stderr || e.message).trim());
  }
}
async function gitLenient(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}
async function gitBuffer(cwd, args) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER, encoding: "buffer" });
  return stdout;
}
async function repoRoot(cwd) {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return out.trim();
}
async function mainWorktree(cwd) {
  try {
    const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const common = out.trim();
    if (!common)
      return null;
    return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
  } catch {
    return null;
  }
}
async function resolveCommit(cwd, rev) {
  try {
    const out = await git(cwd, ["rev-parse", "--verify", rev + "^{commit}"]);
    return out.trim();
  } catch {
    throw new GitError("unknown revision: " + rev);
  }
}
async function describe(cwd, sha) {
  const out = await gitLenient(cwd, ["name-rev", "--name-only", "--no-undefined", sha]);
  return out.trim();
}
async function resolveRevs(cwd, req) {
  const positional = req.args;
  const headArg = req.head ?? positional[0];
  const baseArg = req.base ?? positional[1];
  if (!headArg && !baseArg) {
    const head2 = await resolveCommit(cwd, "HEAD");
    const mode = req.staged ? "staged" : "worktree";
    return {
      mode,
      base: head2,
      head: "WORKTREE",
      baseLabel: "HEAD",
      headLabel: req.staged ? "index" : "working tree"
    };
  }
  if (headArg && !baseArg) {
    const head2 = await resolveCommit(cwd, "HEAD");
    const other = await resolveCommit(cwd, headArg);
    const mergeBase = (await git(cwd, ["merge-base", head2, other])).trim();
    return {
      mode: "range",
      base: mergeBase,
      head: head2,
      baseLabel: headArg,
      headLabel: await describe(cwd, head2) || head2.slice(0, 7)
    };
  }
  const head = await resolveCommit(cwd, headArg);
  const base = await resolveCommit(cwd, baseArg);
  return { mode: "range", base, head, baseLabel: baseArg, headLabel: headArg };
}
var BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|wav|flac|sqlite|db)$/i;
var IMAGE_EXT2 = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}
async function untrackedFiles(cwd) {
  const out = await gitLenient(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = out.split(NUL).filter(Boolean);
  const files = [];
  for (const rel of paths) {
    let buf;
    try {
      buf = await readFile(path.join(cwd, rel));
    } catch {
      continue;
    }
    const binary = BINARY_EXT.test(rel) || looksBinary(buf);
    const file = {
      path: rel,
      hash: createHash2("sha1").update(rel).update(buf).digest("hex").slice(0, 16),
      oldPath: null,
      status: "added",
      additions: 0,
      deletions: 0,
      binary,
      large: false,
      image: IMAGE_EXT2.test(rel),
      oldTotal: 0,
      newTotal: null,
      hunks: []
    };
    if (binary) {
      files.push(file);
      continue;
    }
    const text = buf.toString("utf8");
    const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split(`
`);
    file.additions = lines.length;
    file.newTotal = lines.length;
    file.large = lines.length > 20000;
    if (lines.length > 0) {
      file.hunks = [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: lines.length,
          header: "",
          lines: lines.map((text2, i) => ({
            kind: "add",
            oldNumber: null,
            newNumber: i + 1,
            text: text2
          }))
        }
      ];
    }
    files.push(file);
  }
  return files;
}
async function diffFiles(cwd, revs, opts) {
  let patch;
  if (revs.mode === "staged") {
    patch = await git(cwd, ["diff", "--cached", ...DIFF_FLAGS, revs.base]);
  } else if (revs.mode === "worktree") {
    patch = await git(cwd, ["diff", ...DIFF_FLAGS, revs.base]);
  } else {
    patch = await git(cwd, ["diff", ...DIFF_FLAGS, revs.base, revs.head]);
  }
  const files = parsePatch(patch);
  if (revs.mode === "worktree" && opts.untracked) {
    files.push(...await untrackedFiles(cwd));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
async function commitDiff(cwd, sha) {
  const patch = await git(cwd, ["show", "--format=", ...DIFF_FLAGS, sha]);
  if (patch.trim())
    return parsePatch(patch);
  const fallback = await gitLenient(cwd, ["diff", ...DIFF_FLAGS, sha + "^1", sha]);
  return parsePatch(fallback);
}
async function commits(cwd, revs) {
  if (revs.mode !== "range")
    return [];
  const out = await gitLenient(cwd, [
    "log",
    "--reverse",
    "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s",
    revs.base + ".." + revs.head
  ]);
  return out.split(`
`).filter(Boolean).map((line) => {
    const [sha, shortSha, author, date, ...rest] = line.split(SEP);
    return { sha, shortSha, author, date, subject: rest.join(SEP) };
  });
}
function revForSide(revs, side) {
  if (side === "base")
    return revs.base;
  return revs.mode === "range" ? revs.head : null;
}
async function fileLines(cwd, revs, side, filePath) {
  const buf = await fileBlob(cwd, revs, side, filePath);
  if (!buf)
    return null;
  const text = buf.toString("utf8");
  if (text === "")
    return [];
  return text.replace(/\n$/, "").split(`
`);
}
async function fileBlob(cwd, revs, side, filePath) {
  const rev = revForSide(revs, side);
  try {
    if (rev === null) {
      if (revs.mode === "staged")
        return await gitBuffer(cwd, ["show", ":" + filePath]);
      return await readFile(path.join(cwd, filePath));
    }
    return await gitBuffer(cwd, ["show", rev + ":" + filePath]);
  } catch {
    return null;
  }
}

// src/server.ts
import { createServer } from "http";
import { readFile as readFile4, stat as stat2 } from "fs/promises";
import path5 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";

// src/watch.ts
import { watch } from "fs";
import path2 from "path";
var DEBOUNCE_MS = 150;
var POLL_MS = 2000;
var IGNORED = /(^|[\\/])(node_modules|dist|build|target|\.next|coverage|\.turbo|__pycache__)([\\/]|$)/;
var GIT_INTERESTING = /^\.git[\\/](HEAD|index|MERGE_HEAD|refs[\\/]|worktrees[\\/][^\\/]+[\\/](HEAD|index))/;
function watchRepo(cwd, onChange) {
  let timer;
  let closed = false;
  const schedule = () => {
    if (closed)
      return;
    if (timer)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, DEBOUNCE_MS);
  };
  const relevant = (rel) => {
    if (!rel)
      return true;
    const norm = rel.split(path2.sep).join("/");
    if (norm.startsWith(".git/") || norm === ".git")
      return GIT_INTERESTING.test(rel);
    return !IGNORED.test(norm);
  };
  let watcher;
  try {
    watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (relevant(filename ? String(filename) : null))
        schedule();
    });
    watcher.on("error", () => {});
  } catch {}
  const poll = setInterval(schedule, POLL_MS);
  poll.unref();
  return {
    close: () => {
      closed = true;
      if (timer)
        clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    }
  };
}

// src/provenance.ts
import { readFile as readFile2, readdir, stat } from "fs/promises";
import { homedir } from "os";
import path3 from "path";
var WRITES = /(<<\s*['"]?\w+|>\s*\S|\btee\b|\bpython3?\s+-|\b(node|bun)\s+-e|\bsed\s+-i|\bperl\s+-[a-z]*i|\bpatch\b)/;
var SYNTHETIC = [
  "<command-name>",
  "<command-message>",
  "<system-reminder>",
  "<local-command",
  "Base directory for this skill",
  "[Image:",
  "Caveat: The messages below"
];
function slugFor(cwd) {
  return "-" + cwd.replace(/[/.]/g, "-").replace(/^-+/, "");
}
function textOf(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.filter((b) => Boolean(b) && typeof b === "object" && b.type === "text").map((b) => b.text).join(" ");
}
function isHumanTurn(record, text) {
  if (!text.trim())
    return false;
  if (record.isMeta || record.isCompactSummary)
    return false;
  const head = text.trimStart();
  return !SYNTHETIC.some((prefix) => head.startsWith(prefix));
}
function oneLine(text, max) {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
async function transcripts(cwd) {
  const dir = path3.join(homedir(), ".claude", "projects", slugFor(cwd));
  const out = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path3.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl"))
        out.push(full);
      else if (entry.isDirectory()) {
        try {
          for (const sub of await readdir(full)) {
            if (sub.endsWith(".jsonl"))
              out.push(path3.join(full, sub));
          }
        } catch {}
      }
    }
  } catch {
    return [];
  }
  return out.sort();
}
async function buildIndex(cwd) {
  const files = await transcripts(cwd);
  const steps = [];
  let step = 0;
  for (const file of files) {
    let raw;
    try {
      const info = await stat(file);
      if (info.size > 64 * 1024 * 1024)
        continue;
      raw = await readFile2(file, "utf8");
    } catch {
      continue;
    }
    let prompt = null;
    for (const line of raw.split(`
`)) {
      if (!line)
        continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const message = record.message;
      if (!message)
        continue;
      const body = textOf(message.content);
      if (message.role === "user" && isHumanTurn(record, body)) {
        prompt = oneLine(body, 200);
      }
      if (!Array.isArray(message.content))
        continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object")
          continue;
        const b = block;
        if (b.type !== "tool_use" || !b.input)
          continue;
        const input = b.input;
        const text = input.content || input.new_string || input.command;
        if (typeof text !== "string" || !text.trim())
          continue;
        const structured = b.name === "Write" || b.name === "Edit" || b.name === "NotebookEdit";
        if (!structured && !WRITES.test(text))
          continue;
        step += 1;
        steps.push({
          step,
          at: typeof record.timestamp === "string" ? record.timestamp : "",
          caption: oneLine(input.description || b.name || "edit", 90),
          prompt,
          text
        });
      }
    }
  }
  return { steps };
}
function attribute(files, index) {
  if (index.steps.length === 0)
    return;
  for (const file of files) {
    const direct = file.hunks.map(() => null);
    file.hunks.forEach((hunk, i) => {
      const votes = new Map;
      for (const line of hunk.lines) {
        if (line.kind !== "add")
          continue;
        const needle = line.text.trim();
        if (needle.length < 8)
          continue;
        const found = index.steps.find((s) => s.text.includes(needle));
        if (!found)
          continue;
        votes.set(found.step, (votes.get(found.step) ?? 0) + 1);
      }
      if (votes.size === 0)
        return;
      const ranked = Array.from(votes).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (ranked.length > 1 && ranked[0][1] === ranked[1][1])
        return;
      direct[i] = ranked[0][0];
    });
    const resolved = direct.slice();
    for (let i = 0;i < resolved.length; i++) {
      if (resolved[i] !== null)
        continue;
      let best = null;
      let bestDistance = Infinity;
      for (let j = 0;j < direct.length; j++) {
        if (direct[j] === null)
          continue;
        const distance = Math.abs(i - j);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = direct[j];
        }
      }
      resolved[i] = best;
    }
    file.hunks.forEach((hunk, i) => {
      const step = resolved[i];
      if (step === null)
        return;
      const winner = index.steps.find((s) => s.step === step);
      if (!winner)
        return;
      hunk.attribution = {
        caption: winner.caption,
        prompt: winner.prompt,
        step: winner.step,
        at: winner.at,
        source: "claude-code",
        ...direct[i] === null ? { inferred: true } : {}
      };
    });
  }
}

// src/lsp.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { readFile as readFile3 } from "fs/promises";
import path4 from "path";
import { pathToFileURL, fileURLToPath } from "url";
var REGISTRY = [
  {
    id: "tsgo",
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    roles: ["hover", "definition", "references", "symbols", "diagnostics"],
    local: "node_modules/.bin/tsgo",
    markers: ["tsconfig.json", "jsconfig.json"],
    bin: "tsgo",
    args: ["--lsp", "-stdio"]
  },
  {
    id: "biome",
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css"],
    roles: ["diagnostics"],
    local: "node_modules/.bin/biome",
    markers: ["biome.json", "biome.jsonc"],
    bin: "biome",
    args: ["lsp-proxy"]
  },
  {
    id: "rust-analyzer",
    extensions: ["rs"],
    roles: ["hover", "definition", "references", "symbols", "diagnostics"],
    markers: ["Cargo.toml"],
    bin: "rust-analyzer",
    args: []
  }
];
var LANGUAGE_ID = {
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
  rs: "rust"
};
var SYMBOL_KIND = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter"
];
var SEVERITY = ["error", "error", "warning", "info", "hint"];
var REQUEST_TIMEOUT_MS = 20000;
var READY_TIMEOUT_MS = 90000;
function extensionOf(filePath) {
  const name = filePath.split("/").pop() || "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

class Client {
  id;
  spec;
  command;
  root;
  proc = null;
  buffer = Buffer.alloc(0);
  nextId = 1;
  pending = new Map;
  opened = new Map;
  pushed = new Map;
  dirty = new Set;
  waiters = new Map;
  capabilities = {};
  state = "idle";
  error = null;
  ready = null;
  constructor(spec, command, root) {
    this.id = spec.id;
    this.spec = spec;
    this.command = command;
    this.root = root;
  }
  start() {
    if (this.ready)
      return this.ready;
    this.ready = this.boot().catch((err) => {
      this.state = "failed";
      this.error = err.message;
      throw err;
    });
    return this.ready;
  }
  async boot() {
    this.state = "starting";
    const proc = spawn(this.command, this.spec.args, {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    });
    this.proc = proc;
    proc.on("error", (err) => this.die(err.message));
    proc.on("exit", (code) => this.die(`exited with code ${code ?? "null"}`));
    proc.stdout?.on("data", (chunk) => this.onData(chunk));
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
      this.error = stderr.trim() || this.error;
    });
    const result = await this.request("initialize", {
      processId: process.pid,
      rootPath: this.root,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path4.basename(this.root) }],
      initializationOptions: this.spec.initializationOptions,
      capabilities: CLIENT_CAPABILITIES
    }, READY_TIMEOUT_MS);
    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.spec.settings !== undefined) {
      this.notify("workspace/didChangeConfiguration", { settings: this.spec.settings });
    }
    this.state = "ready";
    this.error = null;
  }
  die(reason) {
    if (this.state === "failed")
      return;
    this.state = "failed";
    this.error = this.error || reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.id}: ${reason}`));
    }
    this.pending.clear();
    this.opened.clear();
  }
  write(message) {
    const body = JSON.stringify(message);
    this.proc?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r
\r
${body}`);
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;; ) {
      const split = this.buffer.indexOf(`\r
\r
`);
      if (split < 0)
        return;
      const header = this.buffer.subarray(0, split).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(split + 4);
        continue;
      }
      const length = Number(match[1]);
      const end = split + 4 + length;
      if (this.buffer.length < end)
        return;
      const body = this.buffer.subarray(split + 4, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      try {
        this.dispatch(JSON.parse(body));
      } catch {}
    }
  }
  dispatch(message) {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending)
        return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(message.error.message || "lsp error"));
      else
        pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      if (!uri)
        return;
      const items = message.params.diagnostics ?? [];
      this.pushed.set(uri, items.map((d) => this.toDiagnostic(d)));
      const waiting = this.waiters.get(uri);
      if (waiting) {
        this.waiters.delete(uri);
        for (const resolve of waiting)
          resolve();
      }
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      const result = message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => this.spec.settings ?? {}) : null;
      this.write({ jsonrpc: "2.0", id: message.id, result });
    }
  }
  request(method, params, timeout = REQUEST_TIMEOUT_MS) {
    if (this.state === "failed")
      return Promise.reject(new Error(this.error || `${this.id} is down`));
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
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  supports(capability) {
    const value = this.capabilities[capability];
    return value !== undefined && value !== false && value !== null;
  }
  does(role) {
    if (!this.spec.roles.includes(role))
      return false;
    const capability = {
      hover: "hoverProvider",
      definition: "definitionProvider",
      references: "referencesProvider",
      symbols: "workspaceSymbolProvider",
      diagnostics: "diagnosticProvider"
    }[role];
    if (role === "diagnostics")
      return true;
    return this.supports(capability);
  }
  async open(absolute, text) {
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
          text
        }
      });
      return;
    }
    if (!this.dirty.has(uri))
      return;
    this.dirty.delete(uri);
    const next = version + 1;
    this.opened.set(uri, next);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: next },
      contentChanges: [{ text }]
    });
  }
  touch(absolute) {
    const uri = pathToFileURL(absolute).href;
    if (this.opened.has(uri))
      this.dirty.add(uri);
    this.pushed.delete(uri);
  }
  async diagnostics(absolute) {
    const uri = pathToFileURL(absolute).href;
    if (this.supports("diagnosticProvider")) {
      const result = await this.request("textDocument/diagnostic", {
        textDocument: { uri }
      });
      return (result?.items ?? []).map((d) => this.toDiagnostic(d));
    }
    const known = this.pushed.get(uri);
    if (known)
      return known;
    await new Promise((resolve) => {
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
  toDiagnostic(d) {
    const code = d.code ?? d.codeDescription?.href ?? null;
    return {
      start: { line: d.range?.start?.line ?? 0, character: d.range?.start?.character ?? 0 },
      end: { line: d.range?.end?.line ?? 0, character: d.range?.end?.character ?? 0 },
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      message: String(d.message ?? "").trim(),
      code: code === null ? null : String(code),
      server: this.id
    };
  }
  stop() {
    if (!this.proc)
      return;
    try {
      this.notify("shutdown", null);
      this.notify("exit", null);
    } catch {}
    this.proc.kill();
    this.proc = null;
  }
}
var CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    publishDiagnostics: { relatedInformation: false },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false }
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: { symbolKind: { valueSet: SYMBOL_KIND.map((_, i) => i + 1) } }
  },
  window: { workDoneProgress: true }
};

class LspPool {
  opts;
  clients = new Map;
  commands = new Map;
  roots = new Map;
  textCache = new Map;
  blessed = new Set;
  active = new Set;
  observed = [];
  constructor(opts) {
    this.opts = opts;
    if (!opts.enabled)
      return;
    for (const spec of REGISTRY) {
      const command = resolve(spec, ...this.lookup());
      if (command)
        this.commands.set(spec.id, command);
    }
  }
  lookup() {
    return [this.opts.root, ...this.opts.toolRoots ?? []];
  }
  get enabled() {
    return this.opts.enabled && this.relevantSpecs().length > 0;
  }
  observe(paths) {
    for (const filePath of paths) {
      this.active.add(extensionOf(filePath));
      if (this.observed.length < 2000 && !this.observed.includes(filePath)) {
        this.observed.push(filePath);
      }
    }
  }
  instances(id) {
    return [...this.clients.values()].filter((client) => client.spec.id === id);
  }
  relevantSpecs() {
    return REGISTRY.filter((spec) => {
      if (!this.commands.has(spec.id))
        return false;
      if (this.instances(spec.id).some((c) => c.state === "ready" || c.state === "starting")) {
        return true;
      }
      return spec.extensions.some((ext) => this.active.has(ext));
    });
  }
  projectRoot(spec, absolute) {
    if (!spec.markers)
      return this.opts.root;
    const from = path4.dirname(absolute);
    const memo = `${spec.id}\x00${from}`;
    const hit = this.roots.get(memo);
    if (hit)
      return hit;
    let dir = from;
    let found = this.opts.root;
    for (;; ) {
      if (spec.markers.some((marker) => existsSync(path4.join(dir, marker)))) {
        found = dir;
        break;
      }
      if (dir === this.opts.root)
        break;
      const parent = path4.dirname(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
    this.roots.set(memo, found);
    return found;
  }
  client(spec, absolute) {
    const root = this.projectRoot(spec, absolute);
    const key = `${spec.id}\x00${root}`;
    const hit = this.clients.get(key);
    if (hit)
      return hit;
    const mirrored = this.opts.toolRoots?.map((base) => path4.join(base, path4.relative(this.opts.root, root)));
    const command = resolve(spec, root, ...mirrored ?? [], ...this.lookup()) ?? this.commands.get(spec.id);
    if (!command)
      return null;
    const client = new Client(spec, command, root);
    this.clients.set(key, client);
    return client;
  }
  get root() {
    return this.opts.root;
  }
  get reason() {
    if (!this.opts.enabled)
      return this.opts.reason;
    if (this.commands.size === 0)
      return "no language server found for this repository";
    if (this.relevantSpecs().length === 0)
      return "no language server covers the files in this diff";
    return null;
  }
  status() {
    const relevant = new Set(this.relevantSpecs().map((spec) => spec.id));
    const rows = [];
    for (const spec of REGISTRY) {
      const command = this.commands.get(spec.id) ?? null;
      const live = this.instances(spec.id);
      const best = live.find((c) => c.state === "ready") ?? live.find((c) => c.state === "starting") ?? live.find((c) => c.state === "failed") ?? null;
      rows.push({
        id: spec.id,
        command,
        state: !command || !relevant.has(spec.id) ? "missing" : best?.state ?? "idle",
        error: best?.error ?? null,
        features: best ? features(best) : [],
        extensions: spec.extensions
      });
    }
    return rows;
  }
  for(absolute) {
    const ext = extensionOf(absolute);
    return REGISTRY.filter((spec) => spec.extensions.includes(ext)).map((spec) => this.client(spec, absolute)).filter((c) => !!c && c.state !== "failed");
  }
  resolvePath(relative) {
    const absolute = path4.resolve(this.opts.root, relative);
    if (absolute !== this.opts.root && !absolute.startsWith(this.opts.root + path4.sep))
      return null;
    return absolute;
  }
  async text(absolute) {
    const hit = this.textCache.get(absolute);
    if (hit !== undefined)
      return hit;
    const text = await readFile3(absolute, "utf8");
    if (this.textCache.size > 200)
      this.textCache.clear();
    this.textCache.set(absolute, text);
    return text;
  }
  async ensure(relative) {
    const absolute = this.resolvePath(relative);
    if (!absolute)
      throw new Error("path outside the repository");
    const clients = this.for(absolute);
    if (clients.length === 0)
      throw new Error("no language server for this file type");
    const text = await this.text(absolute);
    const live = [];
    await Promise.all(clients.map(async (client) => {
      try {
        await client.open(absolute, text);
        live.push(client);
      } catch {}
    }));
    return { absolute, clients: live };
  }
  invalidate(relative) {
    const absolute = this.resolvePath(relative);
    if (!absolute)
      return;
    this.textCache.delete(absolute);
    for (const client of this.clients.values())
      client.touch(absolute);
  }
  async hover(relative, position) {
    const { absolute, clients } = await this.ensure(relative);
    const uri = pathToFileURL(absolute).href;
    for (const client of clients) {
      if (!client.does("hover"))
        continue;
      const result = await client.request("textDocument/hover", { textDocument: { uri }, position }).catch(() => null);
      const markdown = renderHover(result?.contents);
      if (!markdown)
        continue;
      return {
        markdown,
        server: client.id,
        start: result.range?.start ?? null,
        end: result.range?.end ?? null
      };
    }
    return null;
  }
  async definition(relative, position) {
    return this.locations(relative, position, "textDocument/definition", {});
  }
  async references(relative, position) {
    return this.locations(relative, position, "textDocument/references", {
      context: { includeDeclaration: false }
    });
  }
  async locations(relative, position, method, extra) {
    const { absolute, clients } = await this.ensure(relative);
    const uri = pathToFileURL(absolute).href;
    const role = method === "textDocument/definition" ? "definition" : "references";
    for (const client of clients) {
      if (!client.does(role))
        continue;
      const result = await client.request(method, { textDocument: { uri }, position, ...extra }).catch(() => null);
      const raw = Array.isArray(result) ? result : result ? [result] : [];
      if (raw.length === 0)
        continue;
      return this.decorate(raw.map((item) => this.toLocation(item)).filter((l) => !!l));
    }
    return [];
  }
  seeds(spec, limit = 4) {
    const byRoot = new Map;
    for (const filePath of this.observed) {
      if (!spec.extensions.includes(extensionOf(filePath)))
        continue;
      const absolute = this.resolvePath(filePath);
      if (!absolute)
        continue;
      const root = this.projectRoot(spec, absolute);
      if (!byRoot.has(root))
        byRoot.set(root, filePath);
      if (byRoot.size >= limit)
        break;
    }
    return [...byRoot.values()];
  }
  async symbols(query, limit = 60) {
    const out = [];
    for (const spec of this.relevantSpecs()) {
      if (!spec.roles.includes("symbols"))
        continue;
      const clients = [];
      for (const seed of this.seeds(spec)) {
        const opened = await this.ensure(seed).catch(() => null);
        if (!opened)
          continue;
        for (const client of opened.clients) {
          if (client.spec.id === spec.id && client.does("symbols") && !clients.includes(client)) {
            clients.push(client);
          }
        }
      }
      const answers = await Promise.all(clients.map((client) => client.request("workspace/symbol", { query }).catch(() => null)));
      const seen = new Set;
      for (const result of answers) {
        const items = Array.isArray(result) ? result : result?.items ?? [];
        for (const item of items) {
          const location = this.toLocation(item.location ?? item);
          if (!location)
            continue;
          const identity = `${location.path}:${location.start.line}:${item.name}`;
          if (seen.has(identity))
            continue;
          seen.add(identity);
          out.push({
            name: String(item.name ?? ""),
            kind: SYMBOL_KIND[(item.kind ?? 1) - 1] ?? "symbol",
            container: item.containerName ? String(item.containerName) : null,
            location
          });
        }
      }
      if (out.length > 0)
        break;
    }
    out.sort((a, b) => Number(a.location.external) - Number(b.location.external));
    return this.decorateSymbols(out.slice(0, limit));
  }
  async diagnostics(relative) {
    const { clients } = await this.ensure(relative);
    const absolute = this.resolvePath(relative);
    const lists = await Promise.all(clients.filter((client) => client.does("diagnostics")).map((client) => client.diagnostics(absolute).catch(() => [])));
    const all = lists.flat();
    const seen = new Set;
    return all.filter((d) => {
      const key = `${d.start.line}:${d.start.character}:${d.message}`;
      if (seen.has(key))
        return false;
      seen.add(key);
      return true;
    });
  }
  toLocation(item) {
    const uri = item?.uri ?? item?.targetUri;
    const range = item?.range ?? item?.targetSelectionRange ?? item?.targetRange;
    if (!uri || !range)
      return null;
    let absolute;
    try {
      absolute = fileURLToPath(uri);
    } catch {
      return null;
    }
    const inside = absolute.startsWith(this.opts.root + path4.sep);
    if (!inside)
      this.blessed.add(absolute);
    return {
      path: inside ? path4.relative(this.opts.root, absolute) : absolute,
      external: !inside,
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
      preview: null
    };
  }
  async decorate(locations) {
    await Promise.all(locations.map(async (location) => {
      const absolute = location.external ? location.path : path4.join(this.opts.root, location.path);
      try {
        const text = await this.text(absolute);
        location.preview = text.split(`
`)[location.start.line]?.trim().slice(0, 200) ?? null;
      } catch {
        location.preview = null;
      }
    }));
    return locations;
  }
  async decorateSymbols(symbols) {
    await this.decorate(symbols.map((s) => s.location));
    return symbols;
  }
  canRead(absolute) {
    return this.blessed.has(absolute);
  }
  stop() {
    for (const client of this.clients.values())
      client.stop();
  }
}
function features(client) {
  if (client.state !== "ready")
    return [];
  return ["hover", "definition", "references", "symbols", "diagnostics"].filter((role) => client.does(role));
}
function resolve(spec, ...roots) {
  if (spec.local) {
    for (const root of roots) {
      const local = path4.join(root, spec.local);
      if (existsSync(local))
        return local;
    }
  }
  for (const dir of (process.env.PATH || "").split(path4.delimiter)) {
    if (!dir)
      continue;
    const candidate = path4.join(dir, spec.bin);
    if (existsSync(candidate))
      return candidate;
  }
  return null;
}
function renderHover(contents) {
  if (!contents)
    return null;
  if (typeof contents === "string")
    return contents.trim() || null;
  if (Array.isArray(contents)) {
    const parts = contents.map((c) => renderHover(c)).filter(Boolean);
    return parts.length ? parts.join(`

`) : null;
  }
  const record = contents;
  if (typeof record.value !== "string")
    return null;
  const value = record.value.trim();
  if (!value)
    return null;
  if (record.language)
    return "```" + record.language + `
` + value + "\n```";
  return value;
}

// src/server.ts
var MIME = {
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
  ".woff2": "font/woff2"
};
var CLIENT_TIMEOUT_MS = 15000;
var FIRST_CONNECT_GRACE_MS = 120000;
function stamp(file) {
  return {
    path: file.path,
    hash: file.hash,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions
  };
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}
function isImage(p) {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(p);
}
async function startServer(opts) {
  const { cwd, revs } = opts;
  const webRoot = path5.join(path5.dirname(fileURLToPath2(import.meta.url)), "web");
  let index = opts.provenance ? await buildIndex(cwd) : { steps: [] };
  const files = await diffFiles(cwd, revs, { untracked: opts.untracked });
  attribute(files, index);
  const commitList = await commits(cwd, revs);
  const payload = {
    version: 1,
    repo: path5.basename(cwd),
    revs,
    files,
    commits: commitList,
    commit: null,
    truncated: false,
    training: opts.training?.info ?? null
  };
  let lspReason = null;
  let lspOk = opts.lsp;
  if (opts.lsp && revs.mode === "range") {
    const head = await resolveCommit(cwd, "HEAD").catch(() => null);
    if (head !== revs.head) {
      lspOk = false;
      lspReason = "language answers come from the worktree, which is not this range's head";
    }
  }
  if (!opts.lsp)
    lspReason = "disabled with --no-lsp";
  const main = opts.lsp ? await mainWorktree(cwd) : null;
  const lsp = new LspPool({
    root: cwd,
    toolRoots: main && main !== cwd ? [main] : [],
    enabled: lspOk,
    reason: lspReason
  });
  lsp.observe(files.map((f) => f.path));
  let lastSeen = 0;
  let sawClient = false;
  const startedAt = Date.now();
  const listeners = new Set;
  let running = false;
  let again = false;
  async function refresh() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (opts.provenance)
          index = await buildIndex(cwd);
        const next = await diffFiles(cwd, revs, { untracked: opts.untracked });
        attribute(next, index);
        const before = new Map(payload.files.map((f) => [f.path, f.hash]));
        const after = new Map(next.map((f) => [f.path, f.hash]));
        const changed = next.filter((f) => before.get(f.path) !== f.hash);
        const removed = payload.files.filter((f) => !after.has(f.path)).map((f) => f.path);
        if (changed.length === 0 && removed.length === 0)
          continue;
        lsp.observe(next.map((f) => f.path));
        for (const file of changed)
          lsp.invalidate(file.path);
        for (const file of removed)
          lsp.invalidate(file);
        payload.version += 1;
        payload.files = next;
        if (revs.mode === "range")
          payload.commits = await commits(cwd, revs);
        const event = {
          version: payload.version,
          stamps: changed.map(stamp),
          removed
        };
        const frame = `data: ${JSON.stringify(event)}

`;
        for (const res of listeners)
          res.write(frame);
      } while (again);
    } catch {} finally {
      running = false;
    }
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { error: err.message });
    });
  });
  async function handle(req, res) {
    const url2 = new URL(req.url || "/", "http://localhost");
    const route = url2.pathname;
    if (route === "/api/diff") {
      lastSeen = Date.now();
      sawClient = true;
      const only = url2.searchParams.get("path");
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
    if (route === "/api/events") {
      lastSeen = Date.now();
      sawClient = true;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      res.write(`retry: 1000

`);
      listeners.add(res);
      const keepAlive = setInterval(() => {
        lastSeen = Date.now();
        res.write(`: ping

`);
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
      await handleLsp(route, url2, res);
      return;
    }
    if (route === "/api/source") {
      const filePath = url2.searchParams.get("path");
      const absolute = filePath ? path5.isAbsolute(filePath) ? lsp.canRead(filePath) ? filePath : null : sourcePath(cwd, filePath) : null;
      if (!absolute) {
        sendJson(res, 404, { error: "no such file" });
        return;
      }
      try {
        const text = await readFile4(absolute, "utf8");
        sendJson(res, 200, { path: filePath, lines: text.replace(/\n$/, "").split(`
`) });
      } catch {
        sendJson(res, 404, { error: "no such file" });
      }
      return;
    }
    if (route === "/api/file") {
      const filePath = url2.searchParams.get("path");
      const side = url2.searchParams.get("side") || "head";
      if (!filePath) {
        sendJson(res, 400, { error: "path required" });
        return;
      }
      const lines = await fileLines(cwd, revs, side, filePath);
      sendJson(res, 200, { lines });
      return;
    }
    if (route === "/api/blob") {
      const filePath = url2.searchParams.get("path");
      const side = url2.searchParams.get("side") || "head";
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
        "content-type": MIME[path5.extname(filePath).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(buf);
      return;
    }
    await serveStatic(route, res, webRoot);
  }
  async function handleTraining(route, req, res) {
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
    if (!(req.headers["content-type"] || "").startsWith("application/json")) {
      sendJson(res, 415, { error: "expected application/json" });
      return;
    }
    let body;
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
  async function handleLsp(route, url2, res) {
    if (route === "/api/lsp/status") {
      const status = {
        enabled: lsp.enabled,
        reason: lsp.reason,
        root: lsp.root,
        servers: lsp.status()
      };
      sendJson(res, 200, status);
      return;
    }
    if (!lsp.enabled) {
      sendJson(res, 409, { error: lsp.reason || "language servers are not available" });
      return;
    }
    if (route === "/api/lsp/symbols") {
      const query = url2.searchParams.get("q") || "";
      sendJson(res, 200, { symbols: await lsp.symbols(query) });
      return;
    }
    const filePath = url2.searchParams.get("path");
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
        line: Number(url2.searchParams.get("line")),
        character: Number(url2.searchParams.get("character"))
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
      sendJson(res, 200, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    sendJson(res, 404, { error: "no such route" });
  }
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve2);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const url = `http://127.0.0.1:${port}`;
  let timer;
  if (opts.autoExit) {
    timer = setInterval(() => {
      const now = Date.now();
      if (!sawClient) {
        if (now - startedAt > FIRST_CONNECT_GRACE_MS)
          process.exit(0);
        return;
      }
      if (listeners.size > 0)
        return;
      if (now - lastSeen > CLIENT_TIMEOUT_MS)
        process.exit(0);
    }, 3000);
    timer.unref();
  }
  const watcher = opts.live ? watchRepo(cwd, () => void refresh()) : null;
  return {
    url,
    close: () => {
      if (timer)
        clearInterval(timer);
      lsp.stop();
      watcher?.close();
      for (const res of listeners)
        res.end();
      server.close();
    }
  };
}
var MAX_BODY = 2 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function sourcePath(cwd, relative) {
  if (path5.isAbsolute(relative))
    return null;
  const absolute = path5.resolve(cwd, relative);
  return absolute.startsWith(cwd + path5.sep) ? absolute : null;
}
async function serveStatic(route, res, webRoot) {
  const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
  const target = path5.join(webRoot, rel);
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat2(target);
    if (info.isDirectory())
      throw new Error("directory");
    const buf = await readFile4(target);
    res.writeHead(200, {
      "content-type": MIME[path5.extname(target).toLowerCase()] || "application/octet-stream"
    });
    res.end(buf);
  } catch {
    try {
      const html = await readFile4(path5.join(webRoot, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(html);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("UI not built. Run `bun run build` in this checkout.");
    }
  }
}

// src/training.ts
import { mkdir, readFile as readFile5, rename, writeFile } from "fs/promises";
import path6 from "path";
var EMPTY_REVIEW = { comments: [], summary: "", verdict: null, submittedAt: null };
async function readJson(file) {
  try {
    return JSON.parse(await readFile5(file, "utf8"));
  } catch {
    return null;
  }
}
async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + `
`);
  await rename(tmp, file);
}
function isString(v) {
  return typeof v === "string";
}
function lineOrNull(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}
function validComment(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const c = raw;
  if (!isString(c.id) || !isString(c.path) || !isString(c.body))
    return null;
  if (c.side !== "base" && c.side !== "head")
    return null;
  const line = lineOrNull(c.line);
  const endLine = line === null ? null : Math.max(line, lineOrNull(c.endLine) ?? line);
  const excerpt = Array.isArray(c.excerpt) ? c.excerpt.filter(isString).slice(0, 200) : [];
  const now = new Date().toISOString();
  return {
    id: c.id.slice(0, 64),
    path: c.path,
    side: c.side,
    line,
    endLine,
    excerpt,
    body: c.body.slice(0, 20000),
    createdAt: isString(c.createdAt) ? c.createdAt : now,
    updatedAt: isString(c.updatedAt) ? c.updatedAt : now
  };
}
function validReview(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const r = raw;
  if (!Array.isArray(r.comments))
    return null;
  const comments = r.comments.map(validComment).filter((c) => c !== null);
  const verdict = r.verdict === "approve" || r.verdict === "request_changes" || r.verdict === "comment" ? r.verdict : null;
  return {
    comments,
    summary: isString(r.summary) ? r.summary.slice(0, 20000) : "",
    verdict,
    submittedAt: isString(r.submittedAt) ? r.submittedAt : null
  };
}
async function openTrainingSession(dir) {
  const root = path6.resolve(dir);
  await mkdir(root, { recursive: true });
  const pr = await readJson(path6.join(root, "pr.json"));
  if (!pr || typeof pr.number !== "number") {
    throw new Error(`${path6.join(root, "pr.json")} is missing or has no pull request number`);
  }
  const info = {
    number: pr.number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    baseRef: pr.baseRef ?? "",
    commitCommand: pr.commitCommand ?? "/review-training:commit"
  };
  const reviewFile = path6.join(root, "review.json");
  const telemetryFile = path6.join(root, "telemetry.json");
  let review = validReview(await readJson(reviewFile)) ?? { ...EMPTY_REVIEW };
  const telemetry = await readJson(telemetryFile) ?? {
    startedAt: new Date().toISOString(),
    files: {}
  };
  await writeJson(telemetryFile, telemetry);
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  return {
    info,
    review: () => review,
    saveReview: async (next) => {
      const valid = validReview(next);
      if (!valid)
        throw new Error("not a review");
      review = valid;
      await enqueue(() => writeJson(reviewFile, review));
      return review;
    },
    record: async (raw) => {
      const event = raw;
      if (!event || !isString(event.path))
        return;
      const entry = telemetry.files[event.path] ?? { firstOpenedAt: null, viewedAt: null };
      const now = new Date().toISOString();
      if (event.kind === "open") {
        if (entry.firstOpenedAt)
          return;
        entry.firstOpenedAt = now;
      } else if (event.kind === "viewed") {
        entry.firstOpenedAt ??= now;
        entry.viewedAt = now;
      } else if (event.kind === "unviewed") {
        entry.viewedAt = null;
      } else {
        return;
      }
      telemetry.files[event.path] = entry;
      await enqueue(() => writeJson(telemetryFile, telemetry));
    }
  };
}

// src/cli.ts
import { writeFile as writeFile2 } from "fs/promises";
import path7 from "path";
var USAGE = `review - read a git diff in your browser

Usage:
  review                       working tree vs HEAD
  review --staged              index vs HEAD
  review <rev>                 HEAD vs merge-base(HEAD, <rev>)
  review <head> <base>         <head> vs <base>

Options:
  -s, --staged                diff the index instead of the working tree
      --base <rev>            set the base explicitly
      --head <rev>            set the head explicitly
      --port <n>              listen on a fixed port (default: ephemeral)
      --no-open               print the URL instead of opening a browser
      --no-untracked          leave untracked files out of the working-tree diff
      --no-provenance         do not read agent session transcripts for hunk captions
      --no-lsp                do not start the repository's language servers
      --training <dir>        run a review-training session stored in <dir>
  -h, --help                  show this help
  -v, --version               show the version
`;
function parseArgs(argv) {
  const opts = {
    args: [],
    staged: false,
    port: 0,
    open: true,
    untracked: true,
    provenance: true,
    lsp: true
  };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "-v":
      case "--version":
        process.stdout.write(`review 0.1.0
`);
        process.exit(0);
        break;
      case "-s":
      case "--staged":
      case "--cached":
        opts.staged = true;
        break;
      case "--no-open":
        opts.open = false;
        break;
      case "--no-provenance":
        opts.provenance = false;
        break;
      case "--no-lsp":
        opts.lsp = false;
        break;
      case "--no-untracked":
        opts.untracked = false;
        break;
      case "--base":
        opts.base = argv[++i];
        break;
      case "--head":
        opts.head = argv[++i];
        break;
      case "--port":
        opts.port = Number(argv[++i]);
        break;
      case "--training":
        opts.training = argv[++i];
        if (!opts.training)
          fail("--training needs a directory");
        break;
      default:
        if (arg.startsWith("-")) {
          fail(`unknown option: ${arg}`);
        }
        opts.args.push(arg);
    }
  }
  if (opts.args.length > 2)
    fail("expected at most two revisions");
  return opts;
}
function fail(message) {
  process.stderr.write(`review: ${message}
`);
  process.exit(1);
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn2(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
  child.on("error", () => {});
  child.unref();
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cwd;
  try {
    cwd = await repoRoot(process.cwd());
  } catch {
    fail("not a git repository");
  }
  let revs;
  try {
    revs = await resolveRevs(cwd, opts);
  } catch (err) {
    fail(err instanceof GitError ? err.message : String(err));
  }
  let training = null;
  if (opts.training) {
    try {
      training = await openTrainingSession(opts.training);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  const server = await startServer({
    cwd,
    revs,
    untracked: opts.untracked,
    port: opts.port,
    autoExit: opts.open && !training,
    live: revs.mode !== "range" && !training,
    provenance: opts.provenance && !training,
    lsp: opts.lsp,
    training
  });
  if (opts.training) {
    await writeFile2(path7.join(path7.resolve(opts.training), "server.json"), JSON.stringify({ pid: process.pid, url: server.url }, null, 2) + `
`);
  }
  const range = revs.mode === "range" ? `${revs.baseLabel} -> ${revs.headLabel}` : `${revs.headLabel} vs ${revs.baseLabel}`;
  process.stdout.write(`review  ${range}
${server.url}
`);
  if (opts.open)
    openBrowser(server.url);
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}
main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
