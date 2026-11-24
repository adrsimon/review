#!/usr/bin/env bun
/**
 * review-training helper. The skills call this for everything that has one
 * right answer (GitHub queries, git plumbing, worktrees, the history file) and
 * keep the judgement (what is an issue, how good a comment is) for the model.
 *
 *   rt.ts doctor [--repo owner/name]
 *   rt.ts candidates [--repo owner/name] [--min-hours 24] [--max-hours 72] [--limit 3]
 *   rt.ts prepare <number> [--repo owner/name] [--no-launch] [--force]
 *   rt.ts launch [id]
 *   rt.ts status
 *   rt.ts collect [id]
 *   rt.ts record <id> <score.json>
 *   rt.ts abandon [id]
 *   rt.ts card [id] [--no-open]
 *   rt.ts stats [--json] [--repo owner/name]
 *   rt.ts reviewers [--repo owner/name]
 *   rt.ts reviewers set <owner/name|all> [skill ...]
 *
 * --repo trains on any GitHub repository you can read, not just the one you
 * are in: it is cloned once (blobless) under $REVIEW_TRAINING_HOME/repos.
 *
 * Reviewers: every session gets the built-in blind review, plus one more blind
 * review per skill configured with `reviewers set` (/review-training:setup).
 * They all run in parallel while the user reviews.
 *
 * Everything lives under $REVIEW_TRAINING_HOME, by default ~/.review-training.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCard, type CardData } from "./card.ts";

/* ------------------------------------------------------------------ setup */

const HOME = process.env.REVIEW_TRAINING_HOME || path.join(os.homedir(), ".review-training");
const SESSIONS = path.join(HOME, "sessions");
const WORKTREES = path.join(HOME, "worktrees");
const CLONES = path.join(HOME, "repos");
const HISTORY = path.join(HOME, "history.jsonl");
const PROFILE = path.join(HOME, "profile.json");
const ACTIVE = path.join(HOME, "active.json");
const LOG = path.join(HOME, "log.md");
const CONFIG = path.join(HOME, "config.json");
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RUBRIC_VERSION = 1;

/** Fixed weights: changing one means bumping RUBRIC_VERSION, or trends lie. */
export const CRITERIA = {
  finding_defects: 30,
  precision: 15,
  severity_calibration: 10,
  design: 10,
  edge_cases_and_tests: 10,
  coverage: 10,
  actionability: 10,
  verdict: 5,
} as const;
export type Criterion = keyof typeof CRITERIA;

export const CATEGORIES = [
  "correctness",
  "security",
  "performance",
  "concurrency",
  "error_handling",
  "api_contract",
  "design",
  "tests",
  "readability",
  "ops_migration",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

const SIZE_MIN = 80;
const SIZE_MAX = 1200;

function fail(message: string): never {
  throw new Error(message);
}

function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim().split("\n").slice(-3).join(" ");
          reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${detail}`));
        } else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const git = (cwd: string, args: string[]) => run("git", args, { cwd });

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, file);
}

function out(value: unknown): void {
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/* ----------------------------------------------------------------- github */

interface Actor {
  login: string;
  __typename: string;
}

interface PrDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: Actor | null;
  mergeCommit: { oid: string } | null;
  reviews: {
    nodes: Array<{
      author: Actor | null;
      state: string;
      body: string;
      submittedAt: string | null;
      commit: { oid: string } | null;
    }>;
  };
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      startLine: number | null;
      originalStartLine: number | null;
      diffSide: string;
      comments: {
        nodes: Array<{
          author: Actor | null;
          body: string;
          createdAt: string;
          originalCommit: { oid: string } | null;
          diffHunk: string;
        }>;
      };
    }>;
  };
  comments: { nodes: Array<{ author: Actor | null; body: string; createdAt: string }> };
  commits: { nodes: Array<{ commit: { oid: string; committedDate: string; messageHeadline: string } }> };
}

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body url baseRefName baseRefOid headRefOid mergedAt
      additions deletions changedFiles
      author { login __typename }
      mergeCommit { oid }
      reviews(first: 100) {
        nodes { author { login __typename } state body submittedAt commit { oid } }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved isOutdated path line originalLine startLine originalStartLine diffSide
          comments(first: 50) {
            nodes { author { login __typename } body createdAt originalCommit { oid } diffHunk }
          }
        }
      }
      comments(first: 100) { nodes { author { login __typename } body createdAt } }
      commits(last: 100) { nodes { commit { oid committedDate messageHeadline } } }
    }
  }
}`;

async function gh(args: string[], cwd?: string): Promise<string> {
  return run("gh", args, { cwd });
}

async function fetchPr(repo: string, number: number): Promise<PrDetails> {
  const [owner, name] = repo.split("/");
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${PR_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  const pr = JSON.parse(raw)?.data?.repository?.pullRequest as PrDetails | null;
  if (!pr) fail(`pull request #${number} not found in ${repo}`);
  return pr;
}

/** Humans only: bots review a lot and are not the bar being trained against. */
function isHuman(actor: Actor | null): actor is Actor {
  return !!actor && actor.__typename !== "Bot" && !actor.login.endsWith("[bot]");
}

/** Categories guessed from the words reviewers used. Only for picking PRs, never for grading. */
const CATEGORY_HINTS: Array<[Category, RegExp]> = [
  ["security", /\b(secur|auth[nz]?|permission|inject|sanitiz|escap|xss|csrf|secret|token|leak)/i],
  ["performance", /\b(perf|slow|n\s*\+\s*1|quadratic|cache|memory|alloc|latency|index(es)?\b|batch)/i],
  ["concurrency", /\b(race|concurren|lock|mutex|atomic|deadlock|parallel|await|promise\.all|transaction)/i],
  ["error_handling", /\b(error|throw|catch|exception|retry|fallback|fail(s|ure)?\b|swallow)/i],
  ["tests", /\b(test|spec|coverage|assert|mock)/i],
  ["api_contract", /\b(api|contract|breaking|backward|schema|payload|signature|type(s)?\b)/i],
  ["design", /\b(abstraction|refactor|coupl|responsibilit|layer|architecture|duplicat|reuse|extract)/i],
  ["readability", /\b(nam(e|ing)|rename|readab|comment|clarity|confusing|nit)/i],
  ["ops_migration", /\b(migration|deploy|rollout|backfill|feature flag|config|env)/i],
  ["correctness", /\b(bug|wrong|incorrect|edge case|null|undefined|off[- ]by|should be|missing)/i],
];

function hintCategories(texts: string[]): Category[] {
  const found = new Set<Category>();
  for (const text of texts) {
    for (const [cat, re] of CATEGORY_HINTS) if (re.test(text)) found.add(cat);
  }
  return Array.from(found);
}

interface Analysis {
  reviewedSha: string;
  firstReviewAt: string;
  firstReviewer: string;
  humanThreads: PrDetails["reviewThreads"]["nodes"];
  addressedThreads: number;
  commitsAfterReview: number;
  changesRequested: boolean;
  participants: Set<string>;
  categories: Category[];
}

/** What the first human review saw, and how much the PR moved because of it. */
function analyse(pr: PrDetails): Analysis | null {
  const author = pr.author?.login ?? "";
  const reviews = pr.reviews.nodes
    .filter((r) => isHuman(r.author) && r.author.login !== author && r.submittedAt && r.commit)
    .filter((r) => r.state !== "PENDING")
    .sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!));
  const first = reviews[0];
  if (!first) return null;

  const humanThreads = pr.reviewThreads.nodes.filter((t) => {
    const starter = t.comments.nodes[0]?.author ?? null;
    return isHuman(starter) && starter.login !== author;
  });
  const participants = new Set<string>();
  for (const r of pr.reviews.nodes) if (r.author) participants.add(r.author.login);
  for (const t of pr.reviewThreads.nodes) for (const c of t.comments.nodes) if (c.author) participants.add(c.author.login);
  for (const c of pr.comments.nodes) if (c.author) participants.add(c.author.login);

  const reviewTime = first.submittedAt!;
  const commitsAfterReview = pr.commits.nodes.filter((c) => c.commit.committedDate > reviewTime).length;
  const texts = [
    ...humanThreads.flatMap((t) => t.comments.nodes.filter((c) => isHuman(c.author) && c.author.login !== author).map((c) => c.body)),
    ...reviews.map((r) => r.body),
  ];
  return {
    reviewedSha: first.commit!.oid,
    firstReviewAt: reviewTime,
    firstReviewer: first.author!.login,
    humanThreads,
    addressedThreads: humanThreads.filter((t) => t.isResolved || t.isOutdated).length,
    commitsAfterReview,
    changesRequested: reviews.some((r) => r.state === "CHANGES_REQUESTED"),
    participants,
    categories: hintCategories(texts),
  };
}

/* ------------------------------------------------------------------ local */

interface Profile {
  rubricVersion: number;
  /** Per category, issues of that kind the reviewer caught and missed, over all sessions. */
  categories: Partial<Record<Category, { caught: number; missed: number }>>;
}

interface HistoryEntry {
  id: string;
  repo: string;
  number: number;
  title: string;
  status: "graded" | "abandoned";
  at: string;
  rubricVersion?: number;
  overall?: number;
  criteria?: Record<Criterion, number>;
  bonus?: number;
  minutes?: number | null;
  comments?: number;
  recall?: Partial<Record<Severity, { caught: number; total: number }>>;
  caught?: Category[];
  missed?: Category[];
  strengths?: string[];
  weaknesses?: string[];
  reviewers?: string[];
}

async function history(): Promise<HistoryEntry[]> {
  try {
    const text = await readFile(HISTORY, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}

async function profile(): Promise<Profile> {
  return (await readJson<Profile>(PROFILE)) ?? { rubricVersion: RUBRIC_VERSION, categories: {} };
}

/** Categories missed more often than caught, worst first. */
function weakCategories(p: Profile): Category[] {
  return (Object.entries(p.categories) as Array<[Category, { caught: number; missed: number }]>)
    .filter(([, v]) => v.missed > v.caught && v.missed >= 2)
    .sort((a, b) => b[1].missed - b[1].caught - (a[1].missed - a[1].caught))
    .map(([k]) => k);
}

async function repoRoot(): Promise<string> {
  try {
    return (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    fail("not inside a git repository");
  }
}

async function repoName(cwd: string): Promise<string> {
  try {
    return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd)).trim();
  } catch (err) {
    fail(`could not resolve the GitHub repository (is gh authenticated?): ${(err as Error).message}`);
  }
}

/** Accepts owner/name, a github.com URL, or a git remote URL. */
function parseRepoArg(raw: string): string {
  const m = raw.trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) fail(`not a GitHub repository: ${raw} (expected owner/name)`);
  return `${m[1]}/${m[2]}`;
}

/** The current checkout, when it is the repository asked for (or none was). */
async function currentRepo(): Promise<{ root: string; repo: string } | null> {
  try {
    const root = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
    return { root, repo: await repoName(root) };
  } catch {
    return null;
  }
}

/**
 * Where to work for a session: the checkout you are in, or for --repo a
 * blobless clone kept under $REVIEW_TRAINING_HOME/repos, fetched on demand.
 * Blobless keeps the first clone of a large repository to history and trees;
 * file contents arrive only for the commits a session checks out.
 */
async function workspace(args: string[]): Promise<{ root: string; repo: string; cloned: boolean }> {
  const wanted = flag(args, "--repo");
  if (!wanted) {
    const root = await repoRoot();
    return { root, repo: await repoName(root), cloned: false };
  }
  const repo = parseRepoArg(wanted);
  const here = await currentRepo();
  if (here && here.repo.toLowerCase() === repo.toLowerCase()) return { ...here, cloned: false };
  const dir = path.join(CLONES, slug(repo));
  if (!existsSync(path.join(dir, ".git"))) {
    await mkdir(CLONES, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    try {
      await gh(["repo", "clone", repo, dir, "--", "--filter=blob:none", "--no-checkout", "--quiet"]);
    } catch (err) {
      fail(`could not clone ${repo}: ${(err as Error).message}`);
    }
  }
  return { root: dir, repo, cloned: true };
}

async function visibility(repo: string): Promise<"public" | "private" | "internal" | "unknown"> {
  try {
    const v = (await gh(["repo", "view", repo, "--json", "visibility", "-q", ".visibility"])).trim().toLowerCase();
    return v === "public" || v === "private" || v === "internal" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/** The checkout that owns .git: worktrees have no node_modules of their own. */
async function mainCheckout(cwd: string): Promise<string> {
  const common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return common.endsWith("/.git") ? common.slice(0, -5) : cwd;
}

/** The remote that points at this GitHub repository, so fetches go to the right place. */
async function remoteFor(cwd: string, repo: string): Promise<string> {
  const lines = (await git(cwd, ["remote", "-v"])).split("\n");
  const needle = repo.toLowerCase();
  for (const line of lines) {
    const [name, url] = line.split(/\s+/);
    if (url && url.toLowerCase().replace(/\.git$/, "").endsWith(needle)) return name;
  }
  return "origin";
}

async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  try {
    await git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Fetch by sha first (works after force-pushes), then the PR ref as a fallback. */
async function ensureCommits(cwd: string, remote: string, number: number, shas: string[]): Promise<void> {
  const missing: string[] = [];
  for (const sha of shas) if (!(await hasCommit(cwd, sha))) missing.push(sha);
  if (missing.length === 0) return;
  try {
    await git(cwd, ["fetch", "--quiet", "--no-tags", remote, ...missing]);
  } catch {
    await git(cwd, ["fetch", "--quiet", "--no-tags", remote, `pull/${number}/head`]).catch(() => {});
  }
  for (const sha of missing) {
    if (!(await hasCommit(cwd, sha))) fail(`could not fetch ${sha.slice(0, 10)} from ${remote}`);
  }
}

function slug(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}

interface Meta {
  id: string;
  status: "active" | "graded" | "abandoned";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  repoRoot: string;
  worktree: string;
  base: string;
  reviewedSha: string;
  finalHead: string;
  mergeCommit: string | null;
  mergedAt: string;
  firstReviewAt: string;
  /** Decides whether the score card may name the repository and PR. */
  visibility?: "public" | "private" | "internal" | "unknown";
  createdAt: string;
  rubricVersion: number;
  files: string[];
  additions: number;
  deletions: number;
  /** Skills that ran as extra blind reviewers, besides the built-in one. */
  reviewers?: string[];
}

async function activeId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const active = await readJson<{ id: string }>(ACTIVE);
  if (!active) fail("no active review-training session; start one with /review-training:start");
  return active.id;
}

async function loadMeta(id: string): Promise<Meta> {
  const meta = await readJson<Meta>(path.join(SESSIONS, id, "meta.json"));
  if (!meta) fail(`no session ${id}`);
  return meta;
}

/**
 * The worktree is a bare checkout: link the main checkout's node_modules into
 * it so the language servers resolve imports instead of reporting every one.
 */
async function linkDependencies(main: string, worktree: string): Promise<number> {
  let linked = 0;
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(path.join(main, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git" || e.name.startsWith(".hive")) continue;
      const childRel = path.join(rel, e.name);
      if (e.name === "node_modules") {
        const target = path.join(worktree, childRel);
        if (existsSync(path.dirname(target)) && !existsSync(target)) {
          await symlink(path.join(main, childRel), target).then(() => linked++, () => {});
        }
        continue;
      }
      // Only descend where the worktree has the same directory: anything else
      // is build output or untracked clutter.
      if (existsSync(path.join(worktree, childRel))) await walk(childRel, depth + 1);
    }
  }
  await walk("", 0);
  return linked;
}

/**
 * The diff viewer. The plugin ships its own build in plugin/review, so an
 * installed plugin needs nothing else; REVIEW_BIN and a source checkout's
 * fresher dist/ take precedence for development.
 */
function viewerCommand(): { cmd: string; args: string[] } {
  if (process.env.REVIEW_BIN) return { cmd: process.env.REVIEW_BIN, args: [] };
  for (const cli of [path.join(PLUGIN_ROOT, "..", "dist", "cli.js"), path.join(PLUGIN_ROOT, "review", "cli.js")]) {
    if (existsSync(cli)) return { cmd: process.execPath, args: [cli] };
  }
  return { cmd: "review", args: [] };
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopServer(dir: string): Promise<void> {
  const server = await readJson<{ pid: number }>(path.join(dir, "server.json"));
  if (server && (await processAlive(server.pid))) {
    try {
      process.kill(server.pid, "SIGINT");
    } catch {
      // Already gone.
    }
  }
  await rm(path.join(dir, "server.json"), { force: true });
}

async function removeWorktree(meta: Meta): Promise<void> {
  if (!existsSync(meta.worktree)) return;
  await git(meta.repoRoot, ["worktree", "remove", "--force", meta.worktree]).catch(async () => {
    await rm(meta.worktree, { recursive: true, force: true });
    await git(meta.repoRoot, ["worktree", "prune"]).catch(() => {});
  });
}

/* --------------------------------------------------------------- commands */

/* -------------------------------------------------------------- reviewers */

/** At most this many skill reviewers per session, on top of the built-in one. */
const MAX_REVIEWERS = 4;

interface Config {
  /** Skill names per repository; "all" applies everywhere. */
  reviewers?: Record<string, string[]>;
}

/** The skills that review a repo: the ones set for all repos, then the repo's own. */
async function skillReviewers(repo: string | null): Promise<string[]> {
  const config = (await readJson<Config>(CONFIG)) ?? {};
  const all = config.reviewers?.all ?? [];
  const own = repo ? (config.reviewers?.[repo] ?? []) : [];
  return Array.from(new Set([...all, ...own])).slice(0, MAX_REVIEWERS);
}

/** Where each reviewer of a session writes. The built-in one keeps the historical name. */
function reviewerOutputs(dir: string, skills: string[]): Array<{ reviewer: string; skill: string | null; out: string }> {
  return [
    { reviewer: "default", skill: null, out: path.join(dir, "agent-review.json") },
    ...skills.map((skill) => ({
      reviewer: skill,
      skill,
      out: path.join(dir, `agent-review.${skill.replace(/[^A-Za-z0-9_-]+/g, "_")}.json`),
    })),
  ];
}

async function reviewers(args: string[]): Promise<void> {
  if (args[0] === "set") {
    const [, rawScope, ...skills] = args;
    if (!rawScope) fail("usage: rt.ts reviewers set <owner/name|all> [skill ...]");
    const scope = rawScope === "all" ? "all" : parseRepoArg(rawScope);
    const names = Array.from(new Set(skills.map((s) => s.trim().replace(/^\//, "")).filter(Boolean)));
    if (names.length > MAX_REVIEWERS) fail(`at most ${MAX_REVIEWERS} reviewer skills per scope`);
    const config = (await readJson<Config>(CONFIG)) ?? {};
    config.reviewers ??= {};
    if (names.length) config.reviewers[scope] = names;
    else delete config.reviewers[scope];
    await mkdir(HOME, { recursive: true });
    await writeJson(CONFIG, config);
    return out({ scope, skills: names, config: config.reviewers });
  }
  const given = flag(args, "--repo");
  const repo = given ? parseRepoArg(given) : ((await currentRepo())?.repo ?? null);
  const config = (await readJson<Config>(CONFIG)) ?? {};
  out({
    repo,
    builtIn: "default",
    skills: await skillReviewers(repo),
    configured: config.reviewers ?? {},
    max: MAX_REVIEWERS,
  });
}

async function candidates(args: string[]): Promise<void> {
  const minHours = Number(flag(args, "--min-hours") ?? 24);
  const maxHours = Number(flag(args, "--max-hours") ?? 72);
  const limit = Number(flag(args, "--limit") ?? 3);
  // No clone needed to list: everything here goes through the GitHub API.
  const wanted = flag(args, "--repo");
  const repo = wanted ? parseRepoArg(wanted) : await repoName(await repoRoot());
  const viewer = (await gh(["api", "user", "-q", ".login"])).trim();
  const now = Date.now();
  const from = new Date(now - maxHours * 3600_000);
  const to = new Date(now - minHours * 3600_000);

  const listed = JSON.parse(
    await gh(
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        "200",
        "--search",
        `merged:>=${from.toISOString().slice(0, 10)}`,
        "--json",
        "number,title,author,mergedAt,additions,deletions,changedFiles",
        "--repo",
        repo,
      ],
    ),
  ) as Array<{
    number: number;
    title: string;
    author: { login: string; is_bot?: boolean } | null;
    mergedAt: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  }>;

  const done = new Set((await history()).filter((h) => h.repo === repo).map((h) => h.number));
  const weak = new Set(weakCategories(await profile()));
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

  const pool = listed.filter((pr) => {
    const merged = new Date(pr.mergedAt);
    if (merged < from || merged > to) return skip("outside the time window"), false;
    if (pr.author?.login === viewer) return skip("yours"), false;
    if (pr.author?.is_bot) return skip("opened by a bot"), false;
    if (done.has(pr.number)) return skip("already trained on"), false;
    const size = pr.additions + pr.deletions;
    if (size < SIZE_MIN || size > SIZE_MAX) return skip(`size outside ${SIZE_MIN}-${SIZE_MAX} lines`), false;
    return true;
  });

  const scored: Array<Record<string, unknown> & { score: number }> = [];
  const queue = pool.slice(0, 40);
  async function worker(): Promise<void> {
    for (let pr = queue.shift(); pr; pr = queue.shift()) {
      let details: PrDetails;
      try {
        details = await fetchPr(repo, pr.number);
      } catch {
        skip("could not be fetched");
        continue;
      }
      const a = analyse(details);
      if (!a) {
        skip("no human review");
        continue;
      }
      if (a.participants.has(viewer)) {
        skip("you took part in it");
        continue;
      }
      if (a.reviewedSha === details.headRefOid) {
        skip("unchanged after its first review");
        continue;
      }
      if (a.humanThreads.length === 0 && !a.changesRequested) {
        skip("no review feedback to compare against");
        continue;
      }
      const size = pr.additions + pr.deletions;
      const sizeFit = size >= 150 && size <= 700 ? 2 : 0;
      const targets = a.categories.filter((c) => weak.has(c));
      const score =
        3 * a.addressedThreads +
        (a.humanThreads.length - a.addressedThreads) +
        2 * Math.min(a.commitsAfterReview, 5) +
        (a.changesRequested ? 3 : 0) +
        sizeFit +
        2 * targets.length;
      // Deliberately nothing about what the reviewers said: these lines are
      // shown to the trainee, and the threads are the answer key.
      scored.push({
        number: pr.number,
        title: pr.title,
        mergedAt: pr.mergedAt,
        size,
        files: pr.changedFiles,
        score,
        targetsWeakness: targets.length > 0,
      });
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  scored.sort((x, y) => y.score - x.score);
  out({
    repo,
    window: { from: from.toISOString(), to: to.toISOString() },
    considered: listed.length,
    skipped,
    candidates: scored.slice(0, limit),
  });
}

async function prepare(args: string[]): Promise<void> {
  const number = Number(args[0]);
  if (!Number.isInteger(number) || number <= 0) fail("usage: rt.ts prepare <number>");
  const active = await readJson<{ id: string }>(ACTIVE);
  if (active && !args.includes("--force")) {
    fail(`session ${active.id} is still active: grade it with /review-training:commit or run \`rt.ts abandon\``);
  }

  const { root, repo, cloned } = await workspace(args);
  const main = cloned ? root : await mainCheckout(root);
  const pr = await fetchPr(repo, number);
  const a = analyse(pr);
  if (!a) fail(`#${number} has no human review to train against`);
  if (!pr.mergedAt) fail(`#${number} is not merged`);

  const remote = cloned ? "origin" : await remoteFor(main, repo);
  const shas = [a.reviewedSha, pr.headRefOid, pr.baseRefOid];
  if (pr.mergeCommit) shas.push(pr.mergeCommit.oid);
  await ensureCommits(main, remote, number, Array.from(new Set(shas)));

  const base = (await git(main, ["merge-base", a.reviewedSha, pr.baseRefOid])).trim();
  const finalBase = (await git(main, ["merge-base", pr.headRefOid, pr.baseRefOid])).trim();
  const id = `${slug(repo)}-${number}-${stamp()}`;
  const dir = path.join(SESSIONS, id);
  const truth = path.join(dir, "ground-truth");
  const worktree = path.join(WORKTREES, id);
  await mkdir(truth, { recursive: true });
  await mkdir(WORKTREES, { recursive: true });

  const reviewedFiles = (await git(main, ["diff", "--name-only", base, a.reviewedSha])).split("\n").filter(Boolean);
  const finalFiles = (await git(main, ["diff", "--name-only", finalBase, pr.headRefOid])).split("\n").filter(Boolean);
  const prFiles = Array.from(new Set([...reviewedFiles, ...finalFiles])).sort();
  const numstat = (await git(main, ["diff", "--numstat", base, a.reviewedSha]))
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const additions = numstat.reduce((n, [add]) => n + (Number(add) || 0), 0);
  const deletions = numstat.reduce((n, [, del]) => n + (Number(del) || 0), 0);

  // What the trainee sees.
  await writeJson(path.join(dir, "pr.json"), {
    number,
    title: pr.title,
    body: pr.body,
    baseRef: pr.baseRefName,
    commitCommand: "/review-training:commit",
  });

  // The answer key. Nothing here is shown until the review is graded.
  const author = pr.author?.login ?? "";
  await writeJson(path.join(truth, "threads.json"), {
    note: "Human review threads. `addressed` means resolved or outdated by a later push.",
    reviewedSha: a.reviewedSha,
    threads: a.humanThreads.map((t) => ({
      path: t.path,
      line: t.originalLine ?? t.line,
      startLine: t.originalStartLine ?? t.startLine,
      side: t.diffSide,
      addressed: t.isResolved || t.isOutdated,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      onReviewedVersion: t.comments.nodes[0]?.originalCommit?.oid === a.reviewedSha,
      diffHunk: t.comments.nodes[0]?.diffHunk ?? "",
      comments: t.comments.nodes.map((c) => ({
        author: c.author?.login ?? "ghost",
        role: c.author?.login === author ? "author" : isHuman(c.author) ? "reviewer" : "bot",
        body: c.body,
        createdAt: c.createdAt,
      })),
    })),
  });
  await writeJson(path.join(truth, "reviews.json"), {
    reviews: pr.reviews.nodes
      .filter((r) => isHuman(r.author) && r.author.login !== author && r.state !== "PENDING")
      .map((r) => ({
        author: r.author!.login,
        state: r.state,
        body: r.body,
        submittedAt: r.submittedAt,
        commit: r.commit?.oid ?? null,
        onReviewedVersion: r.commit?.oid === a.reviewedSha,
      })),
    conversation: pr.comments.nodes
      .filter((c) => isHuman(c.author))
      .map((c) => ({ author: c.author!.login, role: c.author!.login === author ? "author" : "reviewer", body: c.body, createdAt: c.createdAt })),
  });
  await writeFile(path.join(truth, "reviewed.diff"), await git(main, ["diff", "--no-color", base, a.reviewedSha]));
  await writeFile(
    path.join(truth, "post-review.diff"),
    prFiles.length > 0 ? await git(main, ["diff", "--no-color", a.reviewedSha, pr.headRefOid, "--", ...prFiles]) : "",
  );
  await writeFile(path.join(truth, "final.diff"), await git(main, ["diff", "--no-color", finalBase, pr.headRefOid]));
  const log = await git(main, ["log", "--no-color", "--format=%H%x09%cI%x09%s%x09%P", `${a.reviewedSha}..${pr.headRefOid}`]);
  await writeFile(
    path.join(truth, "post-review-commits.txt"),
    log
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, date, subject, parents] = l.split("\t");
        const merge = (parents ?? "").split(" ").length > 1 ? " [merge: may bring in base-branch changes]" : "";
        return `${sha.slice(0, 10)} ${date} ${subject}${merge}`;
      })
      .join("\n") + "\n",
  );

  await git(main, ["worktree", "add", "--detach", "--quiet", worktree, a.reviewedSha]);
  const linked = await linkDependencies(main, worktree);

  const meta: Meta = {
    id,
    status: "active",
    repo,
    number,
    title: pr.title,
    url: pr.url,
    author,
    repoRoot: main,
    worktree,
    base,
    reviewedSha: a.reviewedSha,
    finalHead: pr.headRefOid,
    mergeCommit: pr.mergeCommit?.oid ?? null,
    mergedAt: pr.mergedAt,
    firstReviewAt: a.firstReviewAt,
    visibility: await visibility(repo),
    createdAt: new Date().toISOString(),
    rubricVersion: RUBRIC_VERSION,
    files: reviewedFiles,
    additions,
    deletions,
    reviewers: await skillReviewers(repo),
  };
  await writeJson(path.join(dir, "meta.json"), meta);
  await writeJson(ACTIVE, { id });

  const launched = args.includes("--no-launch") ? null : await launchServer(meta);
  out({
    id,
    number,
    title: pr.title,
    files: reviewedFiles.length,
    additions,
    deletions,
    worktree,
    sessionDir: dir,
    reviewedDiff: path.join(truth, "reviewed.diff"),
    linkedNodeModules: linked,
    url: launched,
    reviewers: reviewerOutputs(dir, meta.reviewers ?? []),
  });
}

async function launchServer(meta: Meta): Promise<string> {
  const dir = path.join(SESSIONS, meta.id);
  const existing = await readJson<{ pid: number; url: string }>(path.join(dir, "server.json"));
  if (existing && (await processAlive(existing.pid))) return existing.url;
  await rm(path.join(dir, "server.json"), { force: true });

  const { cmd, args } = viewerCommand();
  const logFd = openSync(path.join(dir, "review.log"), "a");
  const child = spawn(cmd, [...args, "--base", meta.base, "--head", "HEAD", "--training", dir], {
    cwd: meta.worktree,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.on("error", () => {});
  child.unref();

  for (let i = 0; i < 100; i++) {
    const server = await readJson<{ url: string }>(path.join(dir, "server.json"));
    if (server) return server.url;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const tail = await readFile(path.join(dir, "review.log"), "utf8").catch(() => "");
  fail(`the viewer did not start (${cmd}). Log:\n${tail.split("\n").slice(-10).join("\n")}`);
}

async function launch(args: string[]): Promise<void> {
  const meta = await loadMeta(await activeId(args[0]));
  if (meta.status !== "active") fail(`session ${meta.id} is ${meta.status}`);
  out({ id: meta.id, url: await launchServer(meta) });
}

async function status(): Promise<void> {
  const active = await readJson<{ id: string }>(ACTIVE);
  if (!active) return out({ active: null });
  const meta = await loadMeta(active.id);
  const dir = path.join(SESSIONS, meta.id);
  const review = await readJson<{ comments: unknown[]; submittedAt: string | null; verdict: string | null }>(
    path.join(dir, "review.json"),
  );
  const server = await readJson<{ pid: number; url: string }>(path.join(dir, "server.json"));
  out({
    active: meta.id,
    repo: meta.repo,
    number: meta.number,
    title: meta.title,
    startedAt: meta.createdAt,
    comments: review?.comments.length ?? 0,
    verdict: review?.verdict ?? null,
    submitted: !!review?.submittedAt,
    url: server && (await processAlive(server.pid)) ? server.url : null,
    agentReviewsReady: reviewerOutputs(dir, meta.reviewers ?? []).every((r) => existsSync(r.out)),
  });
}

/** Everything the grader needs, as paths plus the small pieces inline. */
async function collect(args: string[]): Promise<void> {
  const meta = await loadMeta(await activeId(args[0]));
  const dir = path.join(SESSIONS, meta.id);
  const review = await readJson<Record<string, unknown>>(path.join(dir, "review.json"));
  const telemetry = await readJson<{ startedAt: string; files: Record<string, { firstOpenedAt: string | null; viewedAt: string | null }> }>(
    path.join(dir, "telemetry.json"),
  );
  const files = meta.files.map((f) => ({
    path: f,
    opened: !!telemetry?.files[f]?.firstOpenedAt,
    viewed: !!telemetry?.files[f]?.viewedAt,
  }));
  out({
    id: meta.id,
    repo: meta.repo,
    number: meta.number,
    title: meta.title,
    url: meta.url,
    worktree: existsSync(meta.worktree) ? meta.worktree : null,
    reviewedSha: meta.reviewedSha,
    finalHead: meta.finalHead,
    startedAt: telemetry?.startedAt ?? meta.createdAt,
    review: review ?? { comments: [], summary: "", verdict: null, submittedAt: null },
    files,
    paths: {
      sessionDir: dir,
      reviewedDiff: path.join(dir, "ground-truth", "reviewed.diff"),
      threads: path.join(dir, "ground-truth", "threads.json"),
      reviews: path.join(dir, "ground-truth", "reviews.json"),
      postReviewDiff: path.join(dir, "ground-truth", "post-review.diff"),
      postReviewCommits: path.join(dir, "ground-truth", "post-review-commits.txt"),
      finalDiff: path.join(dir, "ground-truth", "final.diff"),
      agentReviews: reviewerOutputs(dir, meta.reviewers ?? []).map((r) => ({
        ...r,
        ready: existsSync(r.out),
      })),
      scoreOut: path.join(dir, "score.json"),
      log: LOG,
      rubric: path.join(PLUGIN_ROOT, "reference", "rubric.md"),
    },
  });
}

interface ScoreFile {
  criteria: Record<Criterion, number>;
  bonus?: number;
  issues: Array<{
    id: string;
    severity: Severity;
    category: Category;
    caught: boolean;
  }>;
  comments?: unknown[];
  strengths?: string[];
  weaknesses?: string[];
}

function validateScore(raw: unknown): ScoreFile {
  const s = raw as ScoreFile;
  if (!s || typeof s !== "object") fail("score file is not an object");
  for (const key of Object.keys(CRITERIA) as Criterion[]) {
    const v = s.criteria?.[key];
    if (typeof v !== "number" || v < 0 || v > 5) fail(`criteria.${key} must be a number from 0 to 5`);
  }
  if (!Array.isArray(s.issues)) fail("issues must be an array");
  for (const issue of s.issues) {
    if (!SEVERITIES.includes(issue.severity)) fail(`issue ${issue.id}: bad severity ${issue.severity}`);
    if (!CATEGORIES.includes(issue.category)) fail(`issue ${issue.id}: bad category ${issue.category}`);
    if (typeof issue.caught !== "boolean") fail(`issue ${issue.id}: caught must be a boolean`);
  }
  const bonus = s.bonus ?? 0;
  if (typeof bonus !== "number" || bonus < 0 || bonus > 5) fail("bonus must be a number from 0 to 5");
  return s;
}

/** The overall score is computed here, not by the model, so it is the same sum every time. */
export function overallScore(criteria: Record<Criterion, number>, bonus: number): number {
  let total = 0;
  for (const [key, weight] of Object.entries(CRITERIA) as Array<[Criterion, number]>) {
    total += (weight * criteria[key]) / 5;
  }
  return Math.min(100, Math.round((total + bonus) * 10) / 10);
}

async function record(args: string[]): Promise<void> {
  const [id, scorePath] = args;
  if (!id || !scorePath) fail("usage: rt.ts record <id> <score.json>");
  const meta = await loadMeta(id);
  if (meta.status !== "active") fail(`session ${id} is already ${meta.status}`);
  const dir = path.join(SESSIONS, id);
  const score = validateScore(await readJson(path.resolve(scorePath)));
  const bonus = score.bonus ?? 0;
  const overall = overallScore(score.criteria, bonus);

  const recall: Partial<Record<Severity, { caught: number; total: number }>> = {};
  const caught = new Set<Category>();
  const missed = new Set<Category>();
  const prof = await profile();
  for (const issue of score.issues) {
    const r = (recall[issue.severity] ??= { caught: 0, total: 0 });
    r.total++;
    if (issue.caught) r.caught++;
    // Nits say little about what a reviewer can see; the profile tracks the rest.
    if (issue.severity === "nit") continue;
    const c = (prof.categories[issue.category] ??= { caught: 0, missed: 0 });
    if (issue.caught) {
      c.caught++;
      caught.add(issue.category);
    } else {
      c.missed++;
      missed.add(issue.category);
    }
  }

  const review = await readJson<{ comments: unknown[]; submittedAt: string | null }>(path.join(dir, "review.json"));
  const telemetry = await readJson<{ startedAt: string }>(path.join(dir, "telemetry.json"));
  const end = review?.submittedAt ?? new Date().toISOString();
  const minutes = telemetry?.startedAt
    ? Math.round((Date.parse(end) - Date.parse(telemetry.startedAt)) / 60000)
    : null;

  const entry: HistoryEntry = {
    id,
    repo: meta.repo,
    number: meta.number,
    title: meta.title,
    status: "graded",
    at: new Date().toISOString(),
    rubricVersion: RUBRIC_VERSION,
    overall,
    criteria: score.criteria,
    bonus,
    minutes,
    comments: review?.comments.length ?? 0,
    recall,
    caught: Array.from(caught),
    missed: Array.from(missed),
    strengths: score.strengths ?? [],
    weaknesses: score.weaknesses ?? [],
    reviewers: meta.reviewers ?? [],
  };

  await writeJson(path.join(dir, "score.json"), { ...score, overall, rubricVersion: RUBRIC_VERSION });
  await mkdir(HOME, { recursive: true });
  await appendFile(HISTORY, JSON.stringify(entry) + "\n");
  prof.rubricVersion = RUBRIC_VERSION;
  await writeJson(PROFILE, prof);
  await finish(meta, "graded");
  out({ id, overall, recall, minutes, log: LOG, weakCategories: weakCategories(prof) });
}

async function finish(meta: Meta, status: Meta["status"]): Promise<void> {
  const dir = path.join(SESSIONS, meta.id);
  await stopServer(dir);
  await removeWorktree(meta);
  await writeJson(path.join(dir, "meta.json"), { ...meta, status });
  const active = await readJson<{ id: string }>(ACTIVE);
  if (active?.id === meta.id) await rm(ACTIVE, { force: true });
}

async function abandon(args: string[]): Promise<void> {
  const meta = await loadMeta(await activeId(args[0]));
  if (meta.status !== "active") fail(`session ${meta.id} is already ${meta.status}`);
  // Recorded anyway: the PR has been seen, so it is no longer a blind review.
  const entry: HistoryEntry = {
    id: meta.id,
    repo: meta.repo,
    number: meta.number,
    title: meta.title,
    status: "abandoned",
    at: new Date().toISOString(),
  };
  await mkdir(HOME, { recursive: true });
  await appendFile(HISTORY, JSON.stringify(entry) + "\n");
  await finish(meta, "abandoned");
  out({ abandoned: meta.id });
}

const CRITERION_LABELS: Record<Criterion, string> = {
  finding_defects: "Finding defects",
  precision: "Precision",
  severity_calibration: "Severity calibration",
  design: "Design",
  edge_cases_and_tests: "Edge cases & tests",
  coverage: "Coverage",
  actionability: "Actionability",
  verdict: "Verdict",
};

function openInBrowser(target: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/** Builds the score card for a graded session and opens it. */
async function card(args: string[]): Promise<void> {
  const explicit = args.find((a) => !a.startsWith("--"));
  let id = explicit;
  if (!id) {
    const last = (await history()).filter((h) => h.status === "graded").at(-1);
    if (!last) fail("no graded session yet");
    id = last.id;
  }
  const meta = await loadMeta(id);
  const dir = path.join(SESSIONS, id);
  const score = await readJson<ScoreFile & { overall: number }>(path.join(dir, "score.json"));
  if (!score) fail(`session ${id} has not been graded`);
  const graded = (await history()).filter((h) => h.status === "graded");
  const index = graded.findIndex((h) => h.id === id);
  const entry = graded[index];
  const previous = index > 0 ? graded[index - 1] : undefined;
  const isPublic = meta.visibility === "public";

  const recall = SEVERITIES.filter((s) => s !== "nit").map((severity) => ({
    severity,
    caught: entry?.recall?.[severity]?.caught ?? 0,
    total: entry?.recall?.[severity]?.total ?? 0,
  }));
  const data: CardData = {
    overall: score.overall,
    bonus: score.bonus ?? 0,
    criteria: (Object.keys(CRITERIA) as Criterion[]).map((key) => ({
      key,
      label: CRITERION_LABELS[key],
      weight: CRITERIA[key],
      score: score.criteria[key],
    })),
    recall,
    prLabel: isPublic ? `${meta.repo}#${meta.number}` : null,
    prTitle: isPublic ? meta.title : null,
    prUrl: isPublic ? meta.url : null,
    files: meta.files.length,
    additions: meta.additions,
    deletions: meta.deletions,
    minutes: entry?.minutes ?? null,
    delta: previous?.overall !== undefined && entry?.overall !== undefined ? Math.round((entry.overall - previous.overall) * 10) / 10 : null,
    session: index >= 0 ? index + 1 : graded.length,
    date: (entry?.at ?? new Date().toISOString()).slice(0, 10),
  };
  const { svg, html } = renderCard(data);
  const svgPath = path.join(dir, "card.svg");
  const htmlPath = path.join(dir, "card.html");
  await writeFile(svgPath, svg);
  await writeFile(htmlPath, html);
  if (!args.includes("--no-open")) openInBrowser(htmlPath);
  out({ id, html: htmlPath, svg: svgPath, namesRepository: isPublic });
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Everything /start needs, checked up front so a first run never dies halfway. */
async function doctor(args: string[]): Promise<void> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const bun = process.versions.bun ?? "";
  const [maj, min] = bun.split(".").map(Number);
  add({
    name: "bun",
    ok: maj > 1 || (maj === 1 && min >= 2),
    detail: bun ? `bun ${bun}` : "not running under bun",
    fix: "Install Bun 1.2 or newer: curl -fsSL https://bun.sh/install | bash",
  });

  const gitVersion = await run("git", ["--version"]).catch(() => null);
  add({ name: "git", ok: gitVersion !== null, detail: gitVersion?.trim() ?? "git not found", fix: "Install git." });

  const ghVersion = await run("gh", ["--version"]).catch(() => null);
  add({
    name: "gh",
    ok: ghVersion !== null,
    detail: ghVersion?.split("\n")[0] ?? "GitHub CLI not found",
    fix: "Install the GitHub CLI: https://cli.github.com",
  });
  let login: string | null = null;
  if (ghVersion) {
    login = await gh(["api", "user", "-q", ".login"]).then((s) => s.trim(), () => null);
    add({
      name: "gh auth",
      ok: login !== null,
      detail: login ? `signed in as ${login}` : "not signed in",
      fix: "Run `gh auth login` (type `! gh auth login` in Claude Code).",
    });
  }

  const wanted = flag(args, "--repo");
  if (login) {
    if (wanted) {
      const repo = parseRepoArg(wanted);
      const ok = await gh(["repo", "view", repo, "--json", "nameWithOwner", "-q", ".nameWithOwner"]).then(
        () => true,
        () => false,
      );
      add({ name: "repository", ok, detail: ok ? repo : `cannot read ${repo}`, fix: "Check the name, or that your gh account can see it." });
    } else {
      const here = await currentRepo();
      add({
        name: "repository",
        ok: here !== null,
        detail: here ? here.repo : "this directory is not a GitHub repository",
        fix: "Run from a GitHub repository, or pass a public one: /review-training:start vercel/next.js",
      });
    }
  }

  const viewer = viewerCommand();
  const viewerPath = viewer.args[0] ?? viewer.cmd;
  const viewerOk = viewer.args.length > 0 ? existsSync(viewerPath) : (await run("which", [viewer.cmd]).then(() => true, () => false));
  add({
    name: "viewer",
    ok: viewerOk,
    detail: viewerOk ? viewerPath : "the diff viewer build is missing from the plugin",
    fix: "Reinstall the plugin, or set REVIEW_BIN to the viewer's cli.js.",
  });

  const problems = checks.filter((c) => !c.ok);
  out({ ok: problems.length === 0, checks, problems: problems.map((c) => `${c.name}: ${c.detail}. ${c.fix ?? ""}`.trim()) });
}

function mean(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}

async function stats(args: string[]): Promise<void> {
  const repo = flag(args, "--repo");
  const all = (await history()).filter((h) => !repo || h.repo === repo);
  const graded = all.filter((h) => h.status === "graded" && h.criteria);
  const recent = graded.slice(-5);
  const before = graded.slice(-10, -5);
  const perCriterion = Object.fromEntries(
    (Object.keys(CRITERIA) as Criterion[]).map((k) => [
      k,
      {
        weight: CRITERIA[k],
        last5: mean(recent.map((h) => h.criteria![k])),
        previous5: mean(before.map((h) => h.criteria![k])),
        allTime: mean(graded.map((h) => h.criteria![k])),
      },
    ]),
  );
  const recall: Record<string, { caught: number; total: number; rate: number | null }> = {};
  for (const sev of SEVERITIES) {
    let caught = 0;
    let total = 0;
    for (const h of graded) {
      caught += h.recall?.[sev]?.caught ?? 0;
      total += h.recall?.[sev]?.total ?? 0;
    }
    recall[sev] = { caught, total, rate: total ? Math.round((caught / total) * 100) : null };
  }
  const repos: Record<string, number> = {};
  for (const h of graded) repos[h.repo] = (repos[h.repo] ?? 0) + 1;
  const prof = await profile();
  const result = {
    sessions: graded.length,
    abandoned: all.filter((h) => h.status === "abandoned").length,
    minutesTotal: graded.reduce((n, h) => n + (h.minutes ?? 0), 0),
    repos,
    overall: {
      last5: mean(recent.map((h) => h.overall!)),
      previous5: mean(before.map((h) => h.overall!)),
      allTime: mean(graded.map((h) => h.overall!)),
      series: graded.map((h) => ({ at: h.at.slice(0, 10), pr: `${h.repo}#${h.number}`, overall: h.overall })),
    },
    criteria: perCriterion,
    recallBySeverity: recall,
    categories: prof.categories,
    weakCategories: weakCategories(prof),
    log: existsSync(LOG) ? LOG : null,
  };
  if (args.includes("--json")) return out(result);

  const lines: string[] = [];
  lines.push(`sessions: ${result.sessions} graded, ${result.abandoned} abandoned, ${result.minutesTotal} min reviewing`);
  if (graded.length === 0) return out(lines.join("\n") + "\n");
  lines.push(`overall:  last 5 ${result.overall.last5 ?? "-"}  previous 5 ${result.overall.previous5 ?? "-"}  all time ${result.overall.allTime ?? "-"}`);
  lines.push("");
  lines.push("criterion                 weight  last5  prev5  all");
  for (const [k, v] of Object.entries(perCriterion)) {
    lines.push(
      `${k.padEnd(25)} ${String(v.weight).padStart(6)}  ${String(v.last5 ?? "-").padStart(5)}  ${String(v.previous5 ?? "-").padStart(5)}  ${String(v.allTime ?? "-").padStart(4)}`,
    );
  }
  lines.push("");
  lines.push("recall:   " + SEVERITIES.map((s) => `${s} ${recall[s].caught}/${recall[s].total}`).join("  "));
  lines.push("repos:    " + Object.entries(repos).map(([r, n]) => `${r} (${n})`).join(", "));
  if (result.weakCategories.length) lines.push("weak:     " + result.weakCategories.join(", "));
  lines.push("");
  lines.push("recent:");
  for (const h of graded.slice(-10)) lines.push(`  ${h.at.slice(0, 10)}  ${String(h.overall).padStart(5)}  ${h.repo}#${h.number}  ${h.title}`);
  out(lines.join("\n") + "\n");
}

/* ------------------------------------------------------------------- main */

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  doctor,
  candidates,
  prepare,
  launch,
  status: () => status(),
  collect,
  record,
  abandon,
  card,
  stats,
  reviewers,
};

if ((import.meta as { main?: boolean }).main) {
  const [command, ...rest] = process.argv.slice(2);
  const fn = command ? COMMANDS[command] : undefined;
  if (!fn) {
    process.stderr.write(`usage: rt.ts <${Object.keys(COMMANDS).join("|")}> ...\n`);
    process.exit(2);
  }
  fn(rest).catch((err) => {
    process.stderr.write(`review-training: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

