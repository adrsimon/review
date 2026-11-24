import { spawn } from "node:child_process";
import { GitError, repoRoot, resolveRevs } from "./git.ts";
import { startServer } from "./server.ts";
import { openTrainingSession, type TrainingSession } from "./training.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE = `review - read a git diff in your browser

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

interface Options {
  args: string[];
  staged: boolean;
  base?: string;
  head?: string;
  port: number;
  open: boolean;
  untracked: boolean;
  provenance: boolean;
  lsp: boolean;
  training?: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    args: [],
    staged: false,
    port: 0,
    open: true,
    untracked: true,
    provenance: true,
    lsp: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "-v":
      case "--version":
        process.stdout.write("review 0.1.0\n");
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
        if (!opts.training) fail("--training needs a directory");
        break;
      default:
        if (arg.startsWith("-")) {
          fail(`unknown option: ${arg}`);
        }
        opts.args.push(arg);
    }
  }
  if (opts.args.length > 2) fail("expected at most two revisions");
  return opts;
}

function fail(message: string): never {
  process.stderr.write(`review: ${message}\n`);
  process.exit(1);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
  child.on("error", () => {});
  child.unref();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  let cwd: string;
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

  let training: TrainingSession | null = null;
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
    // A training session outlives its tab: the reviewer may close it and come
    // back, and the grader stops the server when the review is collected.
    autoExit: opts.open && !training,
    // A commit range cannot move; only the worktree and the index can.
    live: revs.mode !== "range" && !training,
    // Captions explain the change, which is the reviewer's job to work out.
    provenance: opts.provenance && !training,
    lsp: opts.lsp,
    training,
  });

  if (opts.training) {
    await writeFile(
      path.join(path.resolve(opts.training), "server.json"),
      JSON.stringify({ pid: process.pid, url: server.url }, null, 2) + "\n",
    );
  }

  const range =
    revs.mode === "range"
      ? `${revs.baseLabel} -> ${revs.headLabel}`
      : `${revs.headLabel} vs ${revs.baseLabel}`;
  process.stdout.write(`review  ${range}\n${server.url}\n`);

  if (opts.open) openBrowser(server.url);

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
