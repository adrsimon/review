import type { LspPosition } from "../../../src/types.ts";

/**
 * Turning a point on screen into a position in a file.
 *
 * The diff renders each line as highlighted HTML, so there are no per-token
 * elements to hang a handler on. Rather than wrap every token in a span — which
 * would multiply the DOM of a large diff for a feature most lines never use —
 * this asks the browser where the caret would land and counts characters back
 * to the start of the line. The text nodes hold the original characters, so the
 * offset that comes out is the source column, which is what LSP wants.
 */

export interface CodePoint {
  /** Repo-relative path of the file this line belongs to. */
  path: string;
  /** Zero-based, LSP style. */
  position: LspPosition;
  /** The line's text, so callers can read the token without a fetch. */
  text: string;
  /** Character range of the identifier under the point, if there is one. */
  token: { start: number; end: number; value: string } | null;
  /** The element the point landed in, for anchoring a hover card. */
  element: HTMLElement;
}

const WORD = /[A-Za-z0-9_$]/;

function caretOffset(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const caret = doc.caretPositionFromPoint(x, y);
    return caret ? { node: caret.offsetNode, offset: caret.offset } : null;
  }
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** Characters before `node[offset]` within `root`, counting text only. */
function offsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (;;) {
    const current = walker.nextNode();
    if (!current) return null;
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
  }
}

/**
 * The file, line and column under a pointer, or null when the pointer is not
 * over code that has a head-side line to name — a removed line, a gap row, a
 * caption, the gutter.
 */
export function codePointAt(x: number, y: number): CodePoint | null {
  const caret = caretOffset(x, y);
  if (!caret) return null;
  const start = caret.node instanceof HTMLElement ? caret.node : caret.node.parentElement;
  const element = start?.closest<HTMLElement>("[data-code-text]");
  if (!element) return null;

  const path = element.dataset.codePath;
  const line = Number(element.dataset.codeLine);
  if (!path || !Number.isFinite(line) || line < 1) return null;

  const character = offsetWithin(element, caret.node, caret.offset);
  if (character === null) return null;

  const text = element.textContent ?? "";
  let token: CodePoint["token"] = null;
  if (character < text.length && WORD.test(text[character])) {
    let from = character;
    let to = character;
    while (from > 0 && WORD.test(text[from - 1])) from--;
    while (to < text.length && WORD.test(text[to])) to++;
    // A bare number is never a symbol, and asking about one only produces a
    // hover card that says nothing.
    const value = text.slice(from, to);
    if (!/^\d+$/.test(value)) token = { start: from, end: to, value };
  }

  return { path, position: { line: line - 1, character }, text, token, element };
}

/** Where to put a card anchored to a token, in viewport coordinates. */
export function tokenRect(point: CodePoint): DOMRect {
  const element = point.element;
  if (!point.token) return element.getBoundingClientRect();
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let placedStart = false;
  for (;;) {
    const node = walker.nextNode();
    if (!node) break;
    const length = node.textContent?.length ?? 0;
    if (!placedStart && seen + length >= point.token.start) {
      range.setStart(node, point.token.start - seen);
      placedStart = true;
    }
    if (placedStart && seen + length >= point.token.end) {
      range.setEnd(node, point.token.end - seen);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return rect;
      break;
    }
    seen += length;
  }
  return element.getBoundingClientRect();
}
