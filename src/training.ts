import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewComment, ReviewState, TelemetryEvent, TrainingInfo } from "./types.ts";

/**
 * A review-training session lives in one directory that the review-training
 * plugin prepares and later grades. The viewer reads what the reviewer may see from
 * `pr.json` and writes back two files:
 *
 *   review.json     the comments, the summary and the verdict
 *   telemetry.json  when each file was first opened and marked viewed
 *
 * Both are rewritten whole on every change, through a rename, so the grader
 * never reads half a file and a closed tab never loses a comment.
 */

export interface FileTelemetry {
  firstOpenedAt: string | null;
  viewedAt: string | null;
}

export interface Telemetry {
  startedAt: string;
  files: Record<string, FileTelemetry>;
}

export interface TrainingSession {
  info: TrainingInfo;
  review: () => ReviewState;
  saveReview: (next: unknown) => Promise<ReviewState>;
  record: (event: unknown) => Promise<void>;
}

const EMPTY_REVIEW: ReviewState = { comments: [], summary: "", verdict: null, submittedAt: null };

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, file);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function lineOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** The page is trusted to shape the review, not to write arbitrary JSON to disk. */
function validComment(raw: unknown): ReviewComment | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!isString(c.id) || !isString(c.path) || !isString(c.body)) return null;
  if (c.side !== "base" && c.side !== "head") return null;
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
    updatedAt: isString(c.updatedAt) ? c.updatedAt : now,
  };
}

function validReview(raw: unknown): ReviewState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.comments)) return null;
  const comments = r.comments.map(validComment).filter((c): c is ReviewComment => c !== null);
  const verdict =
    r.verdict === "approve" || r.verdict === "request_changes" || r.verdict === "comment"
      ? r.verdict
      : null;
  return {
    comments,
    summary: isString(r.summary) ? r.summary.slice(0, 20000) : "",
    verdict,
    submittedAt: isString(r.submittedAt) ? r.submittedAt : null,
  };
}

export async function openTrainingSession(dir: string): Promise<TrainingSession> {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });
  const pr = await readJson<Partial<TrainingInfo>>(path.join(root, "pr.json"));
  if (!pr || typeof pr.number !== "number") {
    throw new Error(`${path.join(root, "pr.json")} is missing or has no pull request number`);
  }
  const info: TrainingInfo = {
    number: pr.number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    baseRef: pr.baseRef ?? "",
    commitCommand: pr.commitCommand ?? "/review-training:commit",
  };

  const reviewFile = path.join(root, "review.json");
  const telemetryFile = path.join(root, "telemetry.json");
  let review: ReviewState = validReview(await readJson(reviewFile)) ?? { ...EMPTY_REVIEW };
  const telemetry: Telemetry = (await readJson<Telemetry>(telemetryFile)) ?? {
    startedAt: new Date().toISOString(),
    files: {},
  };
  await writeJson(telemetryFile, telemetry);

  // Writes are chained so two quick saves land in the order they were made.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  return {
    info,
    review: () => review,
    saveReview: async (next) => {
      const valid = validReview(next);
      if (!valid) throw new Error("not a review");
      review = valid;
      await enqueue(() => writeJson(reviewFile, review));
      return review;
    },
    record: async (raw) => {
      const event = raw as Partial<TelemetryEvent>;
      if (!event || !isString(event.path)) return;
      const entry = telemetry.files[event.path] ?? { firstOpenedAt: null, viewedAt: null };
      const now = new Date().toISOString();
      if (event.kind === "open") {
        if (entry.firstOpenedAt) return;
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
    },
  };
}
