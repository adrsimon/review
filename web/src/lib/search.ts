import type { DiffFile, LineKind } from "../../../src/types.ts";
import type { Range } from "./words.ts";

/**
 * Find inside the diff.
 *
 * The scope is the patch: every line of every hunk, on both sides, across every
 * file the page is showing. Context beyond the hunks is not searched, because
 * it is not part of what is under review and pulling whole files to search them
 * would turn a keystroke into a repository read. Symbol search, which is the
 * thing you actually want when the answer is elsewhere, goes through the
 * language server instead.
 */

export interface Match {
  path: string;
  hunkIndex: number;
  lineIndex: number;
  start: number;
  end: number;
  /** Enough of the line to show the hit in a list without looking it up again. */
  text: string;
  kind: LineKind;
  /** The number to print: the head side when there is one, the base side else. */
  number: number | null;
}

/** Case-insensitive until the query says otherwise, the way ripgrep reads. */
function smartCase(query: string): boolean {
  return /[A-Z]/.test(query);
}

export function matchRanges(text: string, query: string): Range[] {
  if (!query) return [];
  const sensitive = smartCase(query);
  const haystack = sensitive ? text : text.toLowerCase();
  const needle = sensitive ? query : query.toLowerCase();
  const ranges: Range[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return ranges;
    ranges.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
}

/** Every hit in reading order, which is also the order Enter walks them in. */
export function findMatches(files: DiffFile[], query: string): Match[] {
  if (query.length === 0) return [];
  const out: Match[] = [];
  for (const file of files) {
    file.hunks.forEach((hunk, hunkIndex) => {
      hunk.lines.forEach((line, lineIndex) => {
        for (const range of matchRanges(line.text, query)) {
          out.push({
            path: file.path,
            hunkIndex,
            lineIndex,
            start: range.start,
            end: range.end,
            text: line.text,
            kind: line.kind,
            number: line.newNumber ?? line.oldNumber,
          });
        }
      });
    });
  }
  return out;
}

export function countByFile(matches: Match[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  return counts;
}

export function sameMatch(a: Match | null, b: Match | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.path === b.path &&
    a.hunkIndex === b.hunkIndex &&
    a.lineIndex === b.lineIndex &&
    a.start === b.start
  );
}
