import type { DiffFile, DiffLine } from "../../../src/types.ts";
import { wordDiff, type Range } from "./words.ts";

export interface RowLine extends DiffLine {
  wordRanges?: Range[];
  /** First line of a hunk, used as the anchor for hunk-to-hunk navigation. */
  hunkStart?: boolean;
  /**
   * Where this line sits in the file's patch. Split view reshuffles lines into
   * pairs, so the row itself has to carry its address for a search hit to be
   * able to name it.
   */
  hunkIndex?: number;
  lineIndex?: number;
}

export interface GapItem {
  type: "gap";
  /** Index into the gap list: gap i sits above hunk i, the last one is the tail. */
  index: number;
  /** New-file line numbers still hidden in this gap. */
  from: number;
  to: number | null;
  delta: number;
}

export interface LineItem {
  type: "line";
  line: RowLine;
  hunkIndex: number;
  /** Index within the hunk, so a search hit can name the line it landed on. */
  lineIndex: number;
}

export type Item = GapItem | LineItem;

export interface GapState {
  top: number;
  bottom: number;
}

/** Pair up removed and added lines so word-level highlighting has something to compare. */
function annotateWords(lines: RowLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === "del") d++;
    let a = d;
    while (a < lines.length && lines[a].kind === "add") a++;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    if (dels.length > 0 && dels.length === adds.length) {
      for (let k = 0; k < dels.length; k++) {
        const diff = wordDiff(dels[k].text, adds[k].text);
        dels[k].wordRanges = diff.del;
        adds[k].wordRanges = diff.add;
      }
    }
    i = a > i ? a : i + 1;
  }
}

function contextLine(text: string, newNumber: number, delta: number): RowLine {
  return {
    kind: "context",
    newNumber,
    oldNumber: newNumber - delta,
    text,
  };
}

export function buildItems(
  file: DiffFile,
  gaps: Record<number, GapState>,
  content: string[] | null,
): Item[] {
  const items: Item[] = [];
  const hunks = file.hunks;
  const total = content ? content.length : file.newTotal;

  const pushGap = (index: number, from: number, to: number | null, delta: number) => {
    const state = gaps[index] || { top: 0, bottom: 0 };
    const hiddenTo = to;
    if (from > (hiddenTo ?? Infinity)) return;

    const topEnd = from + state.top - 1;
    for (let n = from; n <= topEnd; n++) {
      const text = content?.[n - 1];
      if (text === undefined) break;
      items.push({ type: "line", line: contextLine(text, n, delta), hunkIndex: -1, lineIndex: -1 });
    }

    const bottomStart = hiddenTo === null ? null : hiddenTo - state.bottom + 1;
    const remainingFrom = from + state.top;
    const remainingTo = hiddenTo === null ? null : (bottomStart ?? hiddenTo + 1) - 1;
    const hasHidden =
      remainingTo === null ? content === null || remainingFrom <= (total ?? 0) : remainingFrom <= remainingTo;
    if (hasHidden) {
      items.push({ type: "gap", index, from: remainingFrom, to: remainingTo, delta });
    }

    if (bottomStart !== null && hiddenTo !== null) {
      for (let n = Math.max(bottomStart, remainingFrom); n <= hiddenTo; n++) {
        const text = content?.[n - 1];
        if (text === undefined) break;
        items.push({ type: "line", line: contextLine(text, n, delta), hunkIndex: -1, lineIndex: -1 });
      }
    }
  };

  hunks.forEach((hunk, i) => {
    const prev = i === 0 ? null : hunks[i - 1];
    const gapFrom = prev ? prev.newStart + prev.newLines : 1;
    const gapTo = hunk.newStart - 1;
    const delta = hunk.newStart - hunk.oldStart;
    if (gapTo >= gapFrom) pushGap(i, gapFrom, gapTo, delta);
    const lines: RowLine[] = hunk.lines.map((line) => ({ ...line }));
    annotateWords(lines);
    if (lines[0]) lines[0].hunkStart = true;
    lines.forEach((line, lineIndex) => {
      line.hunkIndex = i;
      line.lineIndex = lineIndex;
      items.push({ type: "line", line, hunkIndex: i, lineIndex });
    });
  });

  const last = hunks[hunks.length - 1];
  if (last && file.status !== "deleted" && file.status !== "added") {
    // git emits three lines of trailing context, so a shorter tail means the
    // hunk already runs to the end of the file and there is nothing to expand.
    let trailing = 0;
    for (let i = last.lines.length - 1; i >= 0 && last.lines[i].kind === "context"; i--) trailing++;
    const mayHaveMore = content !== null || trailing >= 3;
    const tailFrom = last.newStart + last.newLines;
    const tailTo = total ?? null;
    if (mayHaveMore && (tailTo === null || tailFrom <= tailTo)) {
      pushGap(hunks.length, tailFrom, tailTo, last.newStart - last.oldStart);
    }
  }

  return items;
}

export interface SplitRow {
  left: RowLine | null;
  right: RowLine | null;
}

/** Turn a run of unified lines into side-by-side rows. */
export function toSplitRows(lines: RowLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === "del") d++;
    let a = d;
    while (a < lines.length && lines[a].kind === "add") a++;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    i = a > i ? a : i + 1;
  }
  return rows;
}
