import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Attribution, DiffFile } from "./types.ts";

/**
 * Recovers why a hunk exists from the agent session transcripts on disk.
 *
 * Claude Code writes one JSONL file per session under ~/.claude/projects/<slug>.
 * Every tool call it made is in there, including the text it wrote, so a diff can
 * be joined back to the step that produced it. Nothing leaves the machine.
 */

/** A single step that wrote something, reduced to what the join needs. */
interface WriteStep {
  step: number;
  at: string;
  caption: string;
  prompt: string | null;
  text: string;
}

export interface Index {
  steps: WriteStep[];
}

/**
 * Commands that produce text, as opposed to ones that merely mention it. A
 * `grep` for a line contains that line too, and attributing code to the search
 * that found it is worse than leaving it unattributed.
 */
const WRITES = /(<<\s*['"]?\w+|>\s*\S|\btee\b|\bpython3?\s+-|\b(node|bun)\s+-e|\bsed\s+-i|\bperl\s+-[a-z]*i|\bpatch\b)/;

/** User records that the harness injected rather than a person typing. */
const SYNTHETIC = [
  "<command-name>",
  "<command-message>",
  "<system-reminder>",
  "<local-command",
  "Base directory for this skill",
  "[Image:",
  "Caveat: The messages below",
];

function slugFor(cwd: string): string {
  return "-" + cwd.replace(/[/.]/g, "-").replace(/^-+/, "");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join(" ");
}

function isHumanTurn(record: Record<string, unknown>, text: string): boolean {
  if (!text.trim()) return false;
  if (record.isMeta || record.isCompactSummary) return false;
  const head = text.trimStart();
  return !SYNTHETIC.some((prefix) => head.startsWith(prefix));
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Every session transcript recorded for this working directory. */
async function transcripts(cwd: string): Promise<string[]> {
  const dir = path.join(homedir(), ".claude", "projects", slugFor(cwd));
  const out: string[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
      // Subagent transcripts sit one level down.
      else if (entry.isDirectory()) {
        try {
          for (const sub of await readdir(full)) {
            if (sub.endsWith(".jsonl")) out.push(path.join(full, sub));
          }
        } catch {
          // Unreadable subdirectory: the parent's own sessions still count.
        }
      }
    }
  } catch {
    return [];
  }
  return out.sort();
}

export async function buildIndex(cwd: string): Promise<Index> {
  const files = await transcripts(cwd);
  const steps: WriteStep[] = [];
  let step = 0;

  for (const file of files) {
    let raw: string;
    try {
      const info = await stat(file);
      // A transcript this large is a runaway log rather than a session worth joining.
      if (info.size > 64 * 1024 * 1024) continue;
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }

    let prompt: string | null = null;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = record.message as { role?: string; content?: unknown } | undefined;
      if (!message) continue;
      const body = textOf(message.content);
      if (message.role === "user" && isHumanTurn(record, body)) {
        prompt = oneLine(body, 200);
      }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
        if (b.type !== "tool_use" || !b.input) continue;
        const input = b.input;
        const text =
          (input.content as string) || (input.new_string as string) || (input.command as string);
        if (typeof text !== "string" || !text.trim()) continue;
        const structured = b.name === "Write" || b.name === "Edit" || b.name === "NotebookEdit";
        if (!structured && !WRITES.test(text)) continue;
        step += 1;
        steps.push({
          step,
          at: typeof record.timestamp === "string" ? record.timestamp : "",
          caption: oneLine((input.description as string) || b.name || "edit", 90),
          prompt,
          text,
        });
      }
    }
  }
  return { steps };
}

/**
 * Attach a caption to every hunk we can explain.
 *
 * A line is credited to the *earliest* step that wrote it, the one that
 * introduced it. Preferring the latest looks reasonable and is wrong in
 * practice: agents rewrite whole files through heredocs, so the last step
 * touching a line is usually a wholesale re-emission that would credit the
 * entire diff to whatever happened last.
 */
export function attribute(files: DiffFile[], index: Index): void {
  if (index.steps.length === 0) return;

  for (const file of files) {
    const direct: Array<number | null> = file.hunks.map(() => null);

    file.hunks.forEach((hunk, i) => {
      const votes = new Map<number, number>();
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        const needle = line.text.trim();
        // Short lines are punctuation and match everywhere, so they get no vote.
        if (needle.length < 8) continue;
        const found = index.steps.find((s) => s.text.includes(needle));
        if (!found) continue;
        votes.set(found.step, (votes.get(found.step) ?? 0) + 1);
      }
      if (votes.size === 0) return;

      const ranked = Array.from(votes).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      // A tie means the hunk's lines disagree about where they came from, and a
      // confident wrong caption costs more than an honest blank.
      if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return;
      direct[i] = ranked[0][0];
    });

    /**
     * Hunks that matched nothing take the caption of the nearest hunk that did.
     * A deletion-only hunk can never match on its own, since the text it removes
     * was written before the session, and a step rarely edits one part of a file
     * without owning what sits beside it. These are marked `inferred` so the UI
     * can keep them honest, but leaving them blank makes the step view emptier
     * than the file view, which defeats the point of having it.
     */
    const resolved = direct.slice();
    for (let i = 0; i < resolved.length; i++) {
      if (resolved[i] !== null) continue;
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let j = 0; j < direct.length; j++) {
        if (direct[j] === null) continue;
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
      if (step === null) return;
      const winner = index.steps.find((s) => s.step === step);
      if (!winner) return;
      hunk.attribution = {
        caption: winner.caption,
        prompt: winner.prompt,
        step: winner.step,
        at: winner.at,
        source: "claude-code",
        ...(direct[i] === null ? { inferred: true } : {}),
      };
    });
  }
}
