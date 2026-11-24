import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  PlusIcon,
  WandSparklesIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tip } from "@/components/ui/tip";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type {
  Attribution,
  DiffFile,
  FileStatus,
  LspDiagnostic,
  ReviewComment,
} from "../../../src/types.ts";
import { blobUrl, fetchFileLines } from "../lib/api.ts";
import { highlightLine, languageFor } from "../lib/highlight.ts";
import { buildItems, toSplitRows, type GapState, type Item, type RowLine } from "../lib/rows.ts";
import { matchRanges, type Match } from "../lib/search.ts";
import { applyRanges, type Range } from "../lib/words.ts";
import { lineLabel, type CommentDraft } from "../lib/review.ts";
import { CommentCard, CommentComposer } from "./ReviewComment.tsx";

const EXPAND_STEP = 20;

export interface DiffFileViewProps {
  file: DiffFile;
  mode: "split" | "unified";
  collapsed: boolean;
  onToggleCollapse: (path: string) => void;
  viewed: boolean;
  /** Read at an earlier version, then rewritten underneath the reader. */
  changedSinceRead: boolean;
  onToggleViewed: () => void;
  /** A newer version arrived while this file was on screen and is being held. */
  stale: boolean;
  onRefresh: () => void;
  /** What the language servers say about the head-side file, by line. */
  diagnostics: LspDiagnostic[];
  /** The current find-in-diff query, highlighted wherever it lands. */
  search: string;
  /** The one hit Enter is sitting on, which may be in another file. */
  activeMatch: Match | null;
  /** Set in a training session, where the reader leaves review comments. */
  commenting?: CommentingProps | null;
}

export interface CommentingProps {
  comments: ReviewComment[];
  onAdd: (draft: CommentDraft, body: string) => void;
  onUpdate: (id: string, body: string) => void;
  onRemove: (id: string) => void;
}

/** Where a comment on this line is pinned: removed lines count on the old side. */
interface LineAnchor {
  side: "base" | "head";
  line: number;
}

function anchorOf(line: RowLine | null): LineAnchor | null {
  if (!line) return null;
  if (line.kind === "del") return line.oldNumber === null ? null : { side: "base", line: line.oldNumber };
  return line.newNumber === null ? null : { side: "head", line: line.newNumber };
}

function anchorKey(side: "base" | "head", line: number): string {
  return `${side}:${line}`;
}

/**
 * Pressing the "+" on a line: a plain press starts a drag that selects a range
 * of lines (a click is a drag of one line), shift extends the last range.
 */
type StartComment = (anchor: LineAnchor, event: React.MouseEvent | React.KeyboardEvent) => void;

const STATUS_COLOR: Record<FileStatus, "success" | "warning" | "info" | "highlight"> = {
  added: "success",
  deleted: "warning",
  modified: "info",
  renamed: "highlight",
  copied: "highlight",
};

export const STATUS_DOT: Record<FileStatus, string> = {
  added: "bg-green-500",
  deleted: "bg-red-500",
  modified: "bg-blue-500",
  renamed: "bg-sky-500",
  copied: "bg-sky-500",
};

const SEVERITY_DOT: Record<LspDiagnostic["severity"], string> = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
  hint: "bg-muted-foreground",
};

const SEVERITY_TEXT: Record<LspDiagnostic["severity"], string> = {
  error: "text-red-600 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-400",
  info: "text-blue-600 dark:text-blue-400",
  hint: "text-muted-foreground",
};

interface Decoration {
  search: string;
  /** Set when this very line holds the hit Enter is on. */
  active: Range | null;
}

function renderCode(line: RowLine, lang: string | null, decoration: Decoration): { __html: string } {
  let html = highlightLine(line.text, lang);
  const words = line.wordRanges;
  if (words && words.length > 0) {
    html = applyRanges(html, words, line.kind === "add" ? "word-add" : "word-del");
  }
  if (decoration.search) {
    const hits = matchRanges(line.text, decoration.search);
    if (hits.length > 0) html = applyRanges(html, hits, "search-hit");
  }
  if (decoration.active) html = applyRanges(html, [decoration.active], "search-hit-active");
  return { __html: html || "&nbsp;" };
}

function marker(kind: RowLine["kind"]): string {
  return kind === "add" ? "+" : kind === "del" ? "-" : " ";
}

const GUTTER =
  "w-[1%] min-w-11 select-none whitespace-nowrap border-r border-border/60 px-2 text-right align-top text-muted-foreground";
const CODE = "px-2.5 py-0 align-top whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

function gutterTint(kind: RowLine["kind"] | "empty"): string {
  if (kind === "add") return "diff-add-gutter";
  if (kind === "del") return "diff-del-gutter";
  return "bg-muted";
}

function codeTint(kind: RowLine["kind"] | "empty"): string {
  if (kind === "add") return "diff-add-bg";
  if (kind === "del") return "diff-del-bg";
  if (kind === "empty") return "bg-muted";
  return "";
}

/**
 * Only the head side of the diff has a position a language server can be asked
 * about, because the language server reads the worktree. Carrying the address
 * on the element that holds the text is what lets a pointer be turned back into
 * a file, a line and a column without wrapping every token in a span.
 */
function codeAttributes(path: string, line: RowLine): Record<string, string> | undefined {
  if (line.newNumber === null) return undefined;
  return {
    "data-code-text": "",
    "data-code-path": path,
    "data-code-line": String(line.newNumber),
  };
}

function GapRow({
  item,
  columns,
  onExpand,
  isTail,
  isHead,
}: {
  item: Extract<Item, { type: "gap" }>;
  columns: number;
  onExpand: (index: number, edge: "top" | "bottom", amount: number) => void;
  isTail: boolean;
  isHead: boolean;
}) {
  const hidden = item.to === null ? null : item.to - item.from + 1;
  const label = hidden === null ? "more lines" : `${hidden} hidden line${hidden === 1 ? "" : "s"}`;
  return (
    <tr>
      <td
        colSpan={columns}
        className="border-y border-border/60 bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        <span className="flex items-center gap-1">
          {!isHead && (
            <Button size="xs" variant="ghost" onClick={() => onExpand(item.index, "top", EXPAND_STEP)}>{`down ${EXPAND_STEP}`}</Button>
          )}
          {!isTail && (
            <Button size="xs" variant="ghost" onClick={() => onExpand(item.index, "bottom", EXPAND_STEP)}>{`up ${EXPAND_STEP}`}</Button>
          )}
          {(hidden === null || hidden <= 5000) && (
            <Button size="xs" variant="ghost" onClick={() => onExpand(item.index, "top", Infinity)}>all</Button>
          )}
          <span className="pl-1 font-mono">{label}</span>
        </span>
      </td>
    </tr>
  );
}

/** The agent's own note about the edit that introduced this hunk. */
function CaptionRow({ attribution, columns }: { attribution: Attribution; columns: number }) {
  const when = attribution.at ? new Date(attribution.at) : null;
  const tooltip = [
    attribution.prompt ? `prompt: ${attribution.prompt}` : null,
    when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <tr>
      <td
        colSpan={columns}
        className="border-y border-border/60 bg-muted/60 px-3 py-1"
        title={tooltip || undefined}
      >
        <span className="flex items-center gap-1.5 font-sans text-xs text-muted-foreground">
          <WandSparklesIcon className="size-3" />
          <span className="truncate">{attribution.caption}</span>
        </span>
      </td>
    </tr>
  );
}

/** What the language servers have to say about one line, under that line. */
function DiagnosticRow({
  diagnostics,
  columns,
}: {
  diagnostics: LspDiagnostic[];
  columns: number;
}) {
  return (
    <tr>
      <td colSpan={columns} className="border-y border-border/60 bg-muted/60 px-3 py-1">
        <span className="flex flex-col gap-0.5 font-sans text-xs">
          {diagnostics.map((d, i) => (
            <span key={i} className="flex items-baseline gap-1.5">
              <span className={`h-1.5 w-1.5 flex-none rounded-full ${SEVERITY_DOT[d.severity]}`} />
              <span className={SEVERITY_TEXT[d.severity]}>{d.message}</span>
              <span className="text-[10px] text-muted-foreground">
                {d.server}
                {d.code ? ` ${d.code}` : ""}
              </span>
            </span>
          ))}
        </span>
      </td>
    </tr>
  );
}

/** How close to the scroller's edge, in px, a drag starts scrolling it. */
const DRAG_SCROLL_EDGE = 48;

/**
 * Follows the pointer from a pressed "+" until release, painting the rows in
 * between, then reports the line the drag ended on.
 *
 * Painting goes straight to the DOM: the rows are a memoised React tree that
 * can run to thousands of lines, and re-rendering it on every mouse move would
 * make the selection lag behind the pointer. React takes over again when the
 * draft opens on release. A range stays on the side it started on, so rows
 * that only carry the other side (an added line, when the drag started on a
 * removed one) are passed over rather than ending it.
 */
function dragSelect(
  table: HTMLTableElement,
  start: LineAnchor,
  x: number,
  y: number,
  onDone: (endLine: number) => void,
) {
  const prefix = `${start.side}:`;
  const scroller = table.closest("main") ?? document.scrollingElement;
  let end = start.line;
  let pointer = { x, y };
  let frame = 0;

  const lineOf = (tr: Element | null): number | null => {
    const cell = tr?.querySelector<HTMLElement>(`td[data-anchor^="${prefix}"]`);
    return cell ? Number(cell.dataset.anchor!.slice(prefix.length)) : null;
  };

  const paint = () => {
    const lo = Math.min(start.line, end);
    const hi = Math.max(start.line, end);
    for (const tr of Array.from(table.rows)) {
      const line = lineOf(tr);
      tr.classList.toggle("comment-drag", line !== null && line >= lo && line <= hi);
    }
  };

  const track = () => {
    const tr = document.elementFromPoint(pointer.x, pointer.y)?.closest("tr");
    if (tr && table.contains(tr)) {
      const line = lineOf(tr);
      if (line !== null && line !== end) {
        end = line;
        paint();
      }
    }
  };

  // Keep scrolling while the pointer rests near an edge, re-reading the row
  // under it as the content moves.
  const tick = () => {
    frame = 0;
    if (!scroller) return;
    const box = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    let delta = 0;
    if (pointer.y < box.top + DRAG_SCROLL_EDGE) delta = -Math.ceil((box.top + DRAG_SCROLL_EDGE - pointer.y) / 4);
    else if (pointer.y > box.bottom - DRAG_SCROLL_EDGE) delta = Math.ceil((pointer.y - (box.bottom - DRAG_SCROLL_EDGE)) / 4);
    if (delta === 0) return;
    scroller.scrollTop += delta;
    track();
    frame = requestAnimationFrame(tick);
  };

  const move = (e: MouseEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    track();
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (frame) cancelAnimationFrame(frame);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    for (const tr of Array.from(table.querySelectorAll("tr.comment-drag"))) tr.classList.remove("comment-drag");
    onDone(end);
  };

  document.body.style.userSelect = "none";
  document.body.style.cursor = "ns-resize";
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  paint();
}

function GutterCell({
  line,
  side,
  diagnostics,
  onComment,
}: {
  line: RowLine | null;
  side: "old" | "new";
  diagnostics: LspDiagnostic[] | undefined;
  /** Shown as a "+" on hover; press and drag to select a range of lines. */
  onComment?: StartComment | null;
}) {
  const number = line ? (side === "old" ? line.oldNumber : line.newNumber) : null;
  const worst = diagnostics?.[0];
  const anchor = onComment ? anchorOf(line) : null;
  // A context line is commented from its new-side number only, so it gets one "+".
  const owns = anchor !== null && (anchor.side === "base") === (side === "old");
  return (
    <td
      className={`${GUTTER} ${gutterTint(line ? line.kind : "empty")}`}
      data-anchor={owns ? anchorKey(anchor!.side, anchor!.line) : undefined}
    >
      <span className="flex items-center justify-end gap-1">
        {owns && (
          <button
            type="button"
            title="Comment on this line. Drag to select several lines, or shift-click to extend."
            aria-label="Comment on this line"
            className="comment-plus mr-auto flex h-4 w-4 flex-none cursor-pointer items-center justify-center rounded-md bg-sky-500 text-white opacity-0 shadow-sm transition-[opacity,transform] group-hover/row:opacity-100 hover:scale-110 focus-visible:opacity-100"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              onComment!(anchor!, e);
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onComment!(anchor!, e);
            }}
          >
            <PlusIcon className="size-3" strokeWidth={3} />
          </button>
        )}
        {worst && (
          <span
            className={`h-1.5 w-1.5 flex-none rounded-full ${SEVERITY_DOT[worst.severity]}`}
            title={diagnostics!.map((d) => d.message).join("\n")}
          />
        )}
        {number ?? ""}
      </span>
    </td>
  );
}

interface RowProps {
  path: string;
  lang: string | null;
  decoration: Decoration;
  diagnostics: LspDiagnostic[] | undefined;
  onComment: StartComment | null;
  /** Inside the range a comment is being written about. */
  selected: boolean;
}

function rowClass(selected: boolean): string {
  return selected ? "group/row comment-target" : "group/row";
}

function UnifiedRow({
  line,
  path,
  lang,
  decoration,
  diagnostics,
  onComment,
  selected,
}: RowProps & { line: RowLine }) {
  return (
    <tr
      className={rowClass(selected)}
      data-hunk={line.hunkStart ? "" : undefined}
      data-match={decoration.active ? "" : undefined}
    >
      <GutterCell line={line} side="old" diagnostics={undefined} onComment={onComment} />
      <GutterCell line={line} side="new" diagnostics={diagnostics} onComment={onComment} />
      <td className={`${CODE} ${codeTint(line.kind)}`}>
        <span className="select-none text-muted-foreground">{marker(line.kind)}</span>
        <span {...codeAttributes(path, line)} dangerouslySetInnerHTML={renderCode(line, lang, decoration)} />
      </td>
    </tr>
  );
}

function SplitRow({
  left,
  right,
  path,
  lang,
  leftDecoration,
  rightDecoration,
  diagnostics,
  onComment,
  selected,
}: Omit<RowProps, "decoration"> & {
  left: RowLine | null;
  right: RowLine | null;
  leftDecoration: Decoration;
  rightDecoration: Decoration;
}) {
  const active = leftDecoration.active || rightDecoration.active;
  return (
    <tr
      className={rowClass(selected)}
      data-hunk={left?.hunkStart || right?.hunkStart ? "" : undefined}
      data-match={active ? "" : undefined}
    >
      <GutterCell
        line={left}
        side="old"
        diagnostics={undefined}
        onComment={left?.kind === "del" ? onComment : null}
      />
      <td className={`${CODE} ${codeTint(left ? left.kind : "empty")}`}>
        {left && <span dangerouslySetInnerHTML={renderCode(left, lang, leftDecoration)} />}
      </td>
      <GutterCell line={right} side="new" diagnostics={diagnostics} onComment={onComment} />
      <td className={`${CODE} ${codeTint(right ? right.kind : "empty")}`}>
        {right && (
          <span
            {...codeAttributes(path, right)}
            dangerouslySetInnerHTML={renderCode(right, lang, rightDecoration)}
          />
        )}
      </td>
    </tr>
  );
}

/** The comments pinned under one line, and the composer when it is open there. */
function CommentRow({
  columns,
  comments,
  draft,
  commenting,
  onCancel,
}: {
  columns: number;
  comments: ReviewComment[];
  draft: CommentDraft | null;
  commenting: CommentingProps;
  onCancel: () => void;
}) {
  return (
    <tr>
      <td colSpan={columns} className="border-y border-border/60 bg-muted/60 px-3 py-2">
        <div className="flex max-w-3xl flex-col gap-2">
          {comments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              onUpdate={commenting.onUpdate}
              onRemove={commenting.onRemove}
            />
          ))}
          {draft && (
            <CommentComposer
              label={lineLabel(draft)}
              onSave={(body) => {
                commenting.onAdd(draft, body);
                onCancel();
              }}
              onCancel={onCancel}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

function ImagePair({ file }: { file: DiffFile }) {
  return (
    <div className="flex flex-wrap gap-6 p-4">
      {file.status !== "added" && (
        <figure className="m-0 max-w-[45%]">
          <img
            src={blobUrl(file.oldPath ?? file.path, "base")}
            alt="before"
            className="max-w-full rounded-lg border border-border"
          />
          <figcaption className="pt-1 text-xs text-muted-foreground">before</figcaption>
        </figure>
      )}
      {file.status !== "deleted" && (
        <figure className="m-0 max-w-[45%]">
          <img
            src={blobUrl(file.path, "head")}
            alt="after"
            className="max-w-full rounded-lg border border-border"
          />
          <figcaption className="pt-1 text-xs text-muted-foreground">after</figcaption>
        </figure>
      )}
    </div>
  );
}

export const DiffFileView = memo(function DiffFileView({
  file,
  mode,
  collapsed,
  onToggleCollapse,
  viewed,
  changedSinceRead,
  onToggleViewed,
  stale,
  onRefresh,
  diagnostics,
  search,
  activeMatch,
  commenting,
}: DiffFileViewProps) {
  const [gaps, setGaps] = useState<Record<number, GapState>>({});
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  // Where the last "+" was clicked, so a shift-click can make a range of it.
  const rangeStart = useRef<LineAnchor | null>(null);
  const [content, setContent] = useState<string[] | null>(null);
  const [forceLoad, setForceLoad] = useState(false);
  const lang = useMemo(() => languageFor(file.path), [file.path]);

  const expand = useCallback(
    (index: number, edge: "top" | "bottom", amount: number) => {
      const side = file.status === "deleted" ? "base" : "head";
      void fetchFileLines(file.path, side).then((lines) => {
        if (lines) setContent(lines);
        setGaps((prev) => {
          const current = prev[index] || { top: 0, bottom: 0 };
          const bump = amount === Infinity ? 1e9 : amount;
          return { ...prev, [index]: { ...current, [edge]: current[edge] + bump } };
        });
      });
    },
    [file.path, file.status],
  );

  const items = useMemo(() => buildItems(file, gaps, content), [file, gaps, content]);
  const columns = mode === "split" ? 4 : 3;

  const cancelDraft = useCallback(() => setDraft(null), []);

  const openDraft = useCallback(
    (side: LineAnchor["side"], from: number, to: number) => {
      // The excerpt freezes what the reviewer was looking at, so the grader can
      // read the comment against the code even without line numbers.
      const excerpt: string[] = [];
      for (const item of items) {
        if (item.type !== "line") continue;
        const a = anchorOf(item.line);
        if (a && a.side === side && a.line >= from && a.line <= to) excerpt.push(item.line.text);
      }
      setDraft({ path: file.path, side, line: from, endLine: to, excerpt });
    },
    [items, file.path],
  );

  const startComment = useCallback<StartComment>(
    (anchor, event) => {
      const start = rangeStart.current;
      if (event.shiftKey && start && start.side === anchor.side) {
        openDraft(anchor.side, Math.min(start.line, anchor.line), Math.max(start.line, anchor.line));
        return;
      }
      rangeStart.current = anchor;
      const table = (event.currentTarget as HTMLElement).closest("table");
      if (!table || !("clientY" in event)) {
        openDraft(anchor.side, anchor.line, anchor.line);
        return;
      }
      dragSelect(table, anchor, event.clientX, event.clientY, (end) => {
        openDraft(anchor.side, Math.min(anchor.line, end), Math.max(anchor.line, end));
      });
    },
    [openDraft],
  );

  // Line comments by the line they hang under (the last line of their range).
  const pinned = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of commenting?.comments ?? []) {
      if (c.line === null) continue;
      const key = anchorKey(c.side, c.endLine ?? c.line);
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [commenting?.comments]);

  // Diagnostics arrive as a flat list over the whole file; the rows want them
  // by line, worst first, which is also the order the gutter dot picks from.
  const byLine = useMemo(() => {
    const map = new Map<number, LspDiagnostic[]>();
    for (const d of diagnostics) {
      const line = d.start.line + 1;
      const list = map.get(line) ?? [];
      list.push(d);
      map.set(line, list);
    }
    return map;
  }, [diagnostics]);

  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const d of diagnostics) {
      if (d.severity === "error") errors++;
      else if (d.severity === "warning") warnings++;
    }
    return { errors, warnings };
  }, [diagnostics]);

  const rendered = useMemo(() => {
    const out: React.ReactNode[] = [];
    const placed = new Set<string>();
    let buffer: RowLine[] = [];
    const onComment = commenting ? startComment : null;
    const draftKey =
      draft && draft.line !== null ? anchorKey(draft.side, draft.endLine ?? draft.line) : null;
    const inDraft = (a: LineAnchor | null) =>
      a !== null &&
      draft !== null &&
      draft.line !== null &&
      a.side === draft.side &&
      a.line >= draft.line &&
      a.line <= (draft.endLine ?? draft.line);

    const decorate = (line: RowLine | null, forHead: boolean): Decoration => {
      if (!line) return { search, active: null };
      const isActive =
        activeMatch !== null &&
        activeMatch.path === file.path &&
        activeMatch.hunkIndex === line.hunkIndex &&
        activeMatch.lineIndex === line.lineIndex &&
        // In split view a context line is drawn twice; the hit belongs to the
        // head column, so only that copy carries the active highlight.
        (mode === "unified" || forHead || line.kind === "del");
      return {
        search,
        active: isActive ? { start: activeMatch.start, end: activeMatch.end } : null,
      };
    };

    /**
     * Rows first, then the diagnostics between them. Split view reshuffles a
     * run of removed and added lines into pairs, so a message can only be slid
     * under the line it belongs to once that pairing has happened; deciding
     * earlier would either break the pairing or bunch every message at the end
     * of the run.
     */
    const flush = (key: string) => {
      if (buffer.length === 0) return;
      const rows =
        mode === "unified"
          ? buffer.map((line) => ({ left: null, right: line }))
          : toSplitRows(buffer);
      rows.forEach((row, i) => {
        const head = row.right;
        const found = head?.newNumber == null ? undefined : byLine.get(head.newNumber);
        out.push(
          mode === "unified" ? (
            <UnifiedRow
              key={`${key}-${i}`}
              line={head!}
              path={file.path}
              lang={lang}
              decoration={decorate(head!, true)}
              diagnostics={found}
              onComment={onComment}
              selected={inDraft(anchorOf(head))}
            />
          ) : (
            <SplitRow
              key={`${key}-${i}`}
              left={row.left}
              right={row.right}
              path={file.path}
              lang={lang}
              leftDecoration={decorate(row.left, false)}
              rightDecoration={decorate(row.right, true)}
              diagnostics={found}
              onComment={onComment}
              selected={
                inDraft(row.left?.kind === "del" ? anchorOf(row.left) : null) ||
                inDraft(anchorOf(row.right))
              }
            />
          ),
        );
        if (found && found.length > 0) {
          out.push(<DiagnosticRow key={`${key}-${i}-d`} diagnostics={found} columns={columns} />);
        }
        if (!commenting) return;
        const anchors = [
          mode === "split" && row.left?.kind === "del" ? anchorOf(row.left) : null,
          anchorOf(head),
        ];
        for (const a of anchors) {
          if (!a) continue;
          const k = anchorKey(a.side, a.line);
          if (placed.has(k)) continue;
          const here = pinned.get(k) ?? [];
          const drafting = draftKey === k;
          if (here.length === 0 && !drafting) continue;
          placed.add(k);
          out.push(
            <CommentRow
              key={`${key}-${i}-c-${k}`}
              columns={columns}
              comments={here}
              draft={drafting ? draft : null}
              commenting={commenting}
              onCancel={cancelDraft}
            />,
          );
        }
      });
      buffer = [];
    };

    let captioned = -1;
    items.forEach((item, i) => {
      if (item.type === "line") {
        // A hunk's caption is a row of its own, above the first line it explains.
        const attribution =
          item.line.hunkStart ? file.hunks[item.hunkIndex]?.attribution : undefined;
        if (attribution && item.hunkIndex !== captioned) {
          captioned = item.hunkIndex;
          flush(`b${i}`);
          out.push(
            <CaptionRow key={`c${item.hunkIndex}`} attribution={attribution} columns={columns} />,
          );
        }
        buffer.push(item.line);
        return;
      }
      flush(`b${i}`);
      out.push(
        <GapRow
          key={`g${item.index}-${i}`}
          item={item}
          columns={columns}
          onExpand={expand}
          isTail={item.index === file.hunks.length}
          isHead={item.index === 0}
        />,
      );
    });
    flush("tail");
    return { rows: out, placed };
  }, [
    items,
    mode,
    lang,
    columns,
    expand,
    file.hunks,
    file.path,
    byLine,
    search,
    activeMatch,
    commenting,
    startComment,
    pinned,
    draft,
    cancelDraft,
  ]);

  // Comments on the file itself, and line comments whose line is folded out of
  // view (expanded context is not kept across reloads), sit above the diff.
  const fileComments = (commenting?.comments ?? []).filter(
    (c) => c.line === null || !rendered.placed.has(anchorKey(c.side, c.endLine ?? c.line)),
  );
  const fileDraft = draft !== null && draft.line === null;

  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);
  const showTable = !file.binary && !file.image && (!file.large || forceLoad);

  return (
    <section
      id={`file-${file.path}`}
      data-path={file.path}
      className="mb-4 scroll-mt-2 rounded-2xl border border-border bg-background"
    >
      <header
        className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 rounded-t-2xl border-b border-border bg-muted px-3 py-2"
        onClick={() => onToggleCollapse(file.path)}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-3.5 flex-none text-muted-foreground" />
        )}
        <span className={`h-2 w-2 flex-none rounded-xs ${STATUS_DOT[file.status]}`} />
        <span className="truncate font-mono text-sm">
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-medium">{name}</span>
        </span>
        {file.oldPath && file.status !== "modified" && (
          <Badge variant="muted" size="sm" className="font-mono">
            from {file.oldPath}
          </Badge>
        )}
        <Badge variant={STATUS_COLOR[file.status]} size="sm">
          {file.status}
        </Badge>
        {counts.errors > 0 && (
          <Badge variant="warning" size="sm">
            {counts.errors} error{counts.errors === 1 ? "" : "s"}
          </Badge>
        )}
        {counts.errors === 0 && counts.warnings > 0 && (
          <Badge variant="caution" size="sm">
            {counts.warnings} warning{counts.warnings === 1 ? "" : "s"}
          </Badge>
        )}
        {changedSinceRead && (
          <Badge variant="caution" size="sm">
            changed since you read it
          </Badge>
        )}
        <span className="flex-1" />
        {commenting && (
          <Tip content="Comment on this file"><Button size="xs" variant="ghost" onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (collapsed) onToggleCollapse(file.path);
              setDraft({ path: file.path, side: "head", line: null, endLine: null, excerpt: [] });
            }}><MessageSquareIcon />{commenting.comments.length > 0 ? String(commenting.comments.length) : undefined}</Button></Tip>
        )}
        {stale && (
          <Tip content="A newer version arrived while you were reading. Click to take it."><Button size="xs" variant="outline" onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onRefresh();
            }}>updated</Button></Tip>
        )}
        <span className="font-mono text-xs">
          <span className="font-semibold text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
          <span className="font-semibold text-red-600 dark:text-red-400">-{file.deletions}</span>
        </span>
        <label
          className="flex cursor-pointer select-none items-center gap-1.5 pl-1 text-xs text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox checked={viewed} onCheckedChange={() => onToggleViewed()} />
          viewed
        </label>
      </header>

      {!collapsed && commenting && (fileComments.length > 0 || fileDraft) && (
        <div className="flex max-w-3xl flex-col gap-2 border-b border-border/60 bg-muted/60 px-3 py-2">
          {fileComments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              showLocation
              onUpdate={commenting.onUpdate}
              onRemove={commenting.onRemove}
            />
          ))}
          {fileDraft && (
            <CommentComposer
              label="on the whole file"
              onSave={(body) => {
                commenting.onAdd(draft!, body);
                setDraft(null);
              }}
              onCancel={cancelDraft}
            />
          )}
        </div>
      )}
      {!collapsed && file.binary && !file.image && (
        <div className="p-4 text-sm text-muted-foreground">Binary file not shown.</div>
      )}
      {!collapsed && file.image && <ImagePair file={file} />}
      {!collapsed && file.large && !forceLoad && (
        <div className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <span>This diff is large ({file.additions + file.deletions} changed lines).</span>
          <Button size="xs" variant="outline" onClick={() => setForceLoad(true)}>Load anyway</Button>
        </div>
      )}
      {!collapsed && showTable && (
        <div className="overflow-hidden rounded-b-2xl">
          <table
            className="w-full border-collapse font-mono text-xs leading-5"
            style={{ tabSize: 2 }}
          >
            <tbody>{rendered.rows}</tbody>
          </table>
        </div>
      )}
      {!collapsed && showTable && file.hunks.length === 0 && (
        <div className="p-4 text-sm text-muted-foreground">
          No content changes (mode or rename only).
        </div>
      )}
    </section>
  );
});
