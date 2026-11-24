export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  /** Line number on the base side, null for added lines. */
  oldNumber: number | null;
  /** Line number on the head side, null for deleted lines. */
  newNumber: number | null;
  text: string;
  /** True when git reported "\ No newline at end of file" right after this line. */
  noNewline?: boolean;
}

/** Why a hunk exists, recovered from an agent session transcript. */
export interface Attribution {
  /** The agent's own one-line caption for the edit that introduced these lines. */
  caption: string;
  /** The human turn the edit sat under, when one can be identified. */
  prompt: string | null;
  /** Ordinal of the writing step within the session, for ordering by construction. */
  step: number;
  at: string;
  source: "claude-code";
  /** Carried over from a neighbouring hunk rather than matched line by line. */
  inferred?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
  attribution?: Attribution;
}

export interface DiffFile {
  path: string;
  /** Digest of this file's patch. Identity for live updates and viewed state. */
  hash: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Set when the file is too large to render eagerly. */
  large: boolean;
  image: boolean;
  /** Total line count on each side, when known, so the UI can expand to EOF. */
  oldTotal: number | null;
  newTotal: number | null;
  hunks: Hunk[];
}

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

export type DiffMode = "worktree" | "staged" | "range";

export interface Revs {
  mode: DiffMode;
  base: string;
  head: string;
  baseLabel: string;
  headLabel: string;
}

/** What the client needs to tell whether its copy of a file is current. */
export interface FileStamp {
  path: string;
  hash: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

/** Pushed over SSE whenever the worktree moves. */
export interface DiffEvent {
  version: number;
  stamps: FileStamp[];
  removed: string[];
}

export interface DiffPayload {
  version: number;
  repo: string;
  revs: Revs;
  files: DiffFile[];
  commits: Commit[];
  /** Commit sha when this payload is a single commit picked from the sidebar. */
  commit: string | null;
  truncated: boolean;
  /** Set when the viewer runs as a review-training session. */
  training: TrainingInfo | null;
}

/* ---------------------------------------------------------------- language */

/** Zero-based, like LSP itself. The UI converts on the way in and out. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspLocation {
  /** Repo-relative when the target is inside the repo, absolute otherwise. */
  path: string;
  /** True when the path escaped the repo (a .d.ts in node_modules, say). */
  external: boolean;
  start: LspPosition;
  end: LspPosition;
  /** The target line's text, so a result list reads without a second fetch. */
  preview: string | null;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface LspDiagnostic {
  start: LspPosition;
  end: LspPosition;
  severity: DiagnosticSeverity;
  message: string;
  code: string | null;
  /** Which server said so: "tsgo", "biome", ... */
  server: string;
}

export interface LspHover {
  markdown: string;
  server: string;
  /** The range the hover applies to, when the server reports one. */
  start: LspPosition | null;
  end: LspPosition | null;
}

export interface LspSymbol {
  name: string;
  kind: string;
  container: string | null;
  location: LspLocation;
}

export interface LspServerStatus {
  id: string;
  /** How the binary was found, for when nothing is working. */
  command: string | null;
  state: "missing" | "idle" | "starting" | "ready" | "failed";
  error: string | null;
  features: string[];
  extensions: string[];
}

export interface LspStatus {
  enabled: boolean;
  /** Why the whole thing is off, when it is. */
  reason: string | null;
  root: string;
  servers: LspServerStatus[];
}

/* ---------------------------------------------------------------- training */

/**
 * A reviewer's note on a line range or, with a null line, on a whole file.
 * A comment on the change as a whole is `ReviewState.summary`.
 */
export interface ReviewComment {
  id: string;
  path: string;
  /** Which side of the diff the line number counts on. Deleted lines are "base". */
  side: "base" | "head";
  /** First line of the range, 1-based, or null for a comment on the whole file. */
  line: number | null;
  /** Last line of the range when it spans several, otherwise equal to `line`. */
  endLine: number | null;
  /** The text of the commented lines, frozen when the comment was written. */
  excerpt: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

/** Everything the reviewer wrote. The page owns it; the server only stores it. */
export interface ReviewState {
  comments: ReviewComment[];
  summary: string;
  verdict: ReviewVerdict | null;
  /** Set once the reviewer says they are done. Editing afterwards clears it. */
  submittedAt: string | null;
}

/** What a reviewer gets to see about the pull request: no comments, no outcome. */
export interface TrainingInfo {
  number: number;
  title: string;
  body: string;
  baseRef: string;
  /** The command that grades the review, shown once the reviewer is done. */
  commitCommand: string;
}

export interface TelemetryEvent {
  path: string;
  kind: "open" | "viewed" | "unviewed";
}
