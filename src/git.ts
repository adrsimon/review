import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { parsePatch } from "./parse.ts";
import type { Commit, DiffFile, DiffMode, Revs } from "./types.ts";

const run = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;
const NUL = String.fromCharCode(0);
const SEP = String.fromCharCode(31);

const DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--find-copies",
  "-U3",
  "--patch",
];

export class GitError extends Error {}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError((e.stderr || e.message).trim());
  }
}

/** Like git(), but tolerates a non-zero exit so callers can keep going. */
async function gitLenient(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER, encoding: "buffer" });
  return stdout as unknown as Buffer;
}

export async function repoRoot(cwd: string): Promise<string> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return out.trim();
}

/**
 * The checkout the repository was cloned into, which for a linked worktree is
 * not the worktree itself. Worktrees are often made without installing
 * anything, so it is where a repo-local toolchain actually lives.
 */
export async function mainWorktree(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const common = out.trim();
    if (!common) return null;
    // A plain checkout's common dir is its own .git; a bare one has no parent
    // checkout to speak of.
    return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
  } catch {
    return null;
  }
}

export async function resolveCommit(cwd: string, rev: string): Promise<string> {
  try {
    const out = await git(cwd, ["rev-parse", "--verify", rev + "^{commit}"]);
    return out.trim();
  } catch {
    throw new GitError("unknown revision: " + rev);
  }
}

async function describe(cwd: string, sha: string): Promise<string> {
  const out = await gitLenient(cwd, ["name-rev", "--name-only", "--no-undefined", sha]);
  return out.trim();
}

export interface RevRequest {
  args: string[];
  staged: boolean;
  base?: string;
  head?: string;
}

export async function resolveRevs(cwd: string, req: RevRequest): Promise<Revs> {
  const positional = req.args;
  const headArg = req.head ?? positional[0];
  const baseArg = req.base ?? positional[1];

  if (!headArg && !baseArg) {
    const head = await resolveCommit(cwd, "HEAD");
    const mode: DiffMode = req.staged ? "staged" : "worktree";
    return {
      mode,
      base: head,
      head: "WORKTREE",
      baseLabel: "HEAD",
      headLabel: req.staged ? "index" : "working tree",
    };
  }

  if (headArg && !baseArg) {
    // One revision means "what does my HEAD add on top of it", so compare
    // against the merge base. `git diff main` would also show their commits.
    const head = await resolveCommit(cwd, "HEAD");
    const other = await resolveCommit(cwd, headArg);
    const mergeBase = (await git(cwd, ["merge-base", head, other])).trim();
    return {
      mode: "range",
      base: mergeBase,
      head,
      baseLabel: headArg,
      headLabel: (await describe(cwd, head)) || head.slice(0, 7),
    };
  }

  const head = await resolveCommit(cwd, headArg!);
  const base = await resolveCommit(cwd, baseArg!);
  return { mode: "range", base, head, baseLabel: baseArg!, headLabel: headArg! };
}

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|wav|flac|sqlite|db)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Untracked files never show up in `git diff`, so synthesize an all-added file. */
async function untrackedFiles(cwd: string): Promise<DiffFile[]> {
  const out = await gitLenient(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = out.split(NUL).filter(Boolean);
  const files: DiffFile[] = [];
  for (const rel of paths) {
    let buf: Buffer;
    try {
      buf = await readFile(path.join(cwd, rel));
    } catch {
      continue;
    }
    const binary = BINARY_EXT.test(rel) || looksBinary(buf);
    const file: DiffFile = {
      path: rel,
      hash: createHash("sha1").update(rel).update(buf).digest("hex").slice(0, 16),
      oldPath: null,
      status: "added",
      additions: 0,
      deletions: 0,
      binary,
      large: false,
      image: IMAGE_EXT.test(rel),
      oldTotal: 0,
      newTotal: null,
      hunks: [],
    };
    if (binary) {
      files.push(file);
      continue;
    }
    const text = buf.toString("utf8");
    const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
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
          lines: lines.map((text, i) => ({
            kind: "add" as const,
            oldNumber: null,
            newNumber: i + 1,
            text,
          })),
        },
      ];
    }
    files.push(file);
  }
  return files;
}

export async function diffFiles(
  cwd: string,
  revs: Revs,
  opts: { untracked: boolean },
): Promise<DiffFile[]> {
  let patch: string;
  if (revs.mode === "staged") {
    patch = await git(cwd, ["diff", "--cached", ...DIFF_FLAGS, revs.base]);
  } else if (revs.mode === "worktree") {
    patch = await git(cwd, ["diff", ...DIFF_FLAGS, revs.base]);
  } else {
    patch = await git(cwd, ["diff", ...DIFF_FLAGS, revs.base, revs.head]);
  }
  const files = parsePatch(patch);
  if (revs.mode === "worktree" && opts.untracked) {
    files.push(...(await untrackedFiles(cwd)));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function commitDiff(cwd: string, sha: string): Promise<DiffFile[]> {
  const patch = await git(cwd, ["show", "--format=", ...DIFF_FLAGS, sha]);
  if (patch.trim()) return parsePatch(patch);
  // Merge commits print nothing by default; fall back to first-parent.
  const fallback = await gitLenient(cwd, ["diff", ...DIFF_FLAGS, sha + "^1", sha]);
  return parsePatch(fallback);
}

export async function commits(cwd: string, revs: Revs): Promise<Commit[]> {
  if (revs.mode !== "range") return [];
  // %x1f puts a unit separator in git's output; a literal NUL cannot travel
  // inside an argv string.
  const out = await gitLenient(cwd, [
    "log",
    "--reverse",
    "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s",
    revs.base + ".." + revs.head,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, date, ...rest] = line.split(SEP);
      return { sha, shortSha, author, date, subject: rest.join(SEP) };
    });
}

export type Side = "base" | "head";

function revForSide(revs: Revs, side: Side): string | null {
  if (side === "base") return revs.base;
  return revs.mode === "range" ? revs.head : null;
}

/** Full file contents, used by the UI to expand context beyond the hunks. */
export async function fileLines(
  cwd: string,
  revs: Revs,
  side: Side,
  filePath: string,
): Promise<string[] | null> {
  const buf = await fileBlob(cwd, revs, side, filePath);
  if (!buf) return null;
  const text = buf.toString("utf8");
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

export async function fileBlob(
  cwd: string,
  revs: Revs,
  side: Side,
  filePath: string,
): Promise<Buffer | null> {
  const rev = revForSide(revs, side);
  try {
    if (rev === null) {
      if (revs.mode === "staged") return await gitBuffer(cwd, ["show", ":" + filePath]);
      return await readFile(path.join(cwd, filePath));
    }
    return await gitBuffer(cwd, ["show", rev + ":" + filePath]);
  } catch {
    return null;
  }
}
