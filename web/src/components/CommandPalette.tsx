import { SearchIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LspSymbol } from "../../../src/types.ts";
import { fetchSymbols } from "../lib/lsp.ts";
import { matchRanges, type Match } from "../lib/search.ts";

/**
 * Find, in two registers, in one palette.
 *
 * Plain text searches the patch, which is what you want when you remember what
 * the change looked like. A query starting with `@` goes to the language
 * server's symbol index instead, which is what you want when you remember what
 * the thing was called and not where it lives. They are the same question asked
 * at two distances, so they share a list, and telling them apart by a prefix
 * costs a keystroke rather than a mode.
 *
 * Names are never cropped: the name is the answer, and half of it is not half
 * an answer. Paths are cropped, from the left, because the end of a path says
 * more than its beginning.
 */

const SYMBOL_DEBOUNCE_MS = 180;
const MAX_TEXT_RESULTS = 200;

export interface CommandPaletteProps {
  open: boolean;
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  /** Text hits in reading order, and which one is current. */
  matches: Match[];
  current: number;
  onPickMatch: (index: number) => void;
  onPickSymbol: (symbol: LspSymbol) => void;
  /** False when no language server can answer, which hides symbol mode. */
  symbolsAvailable: boolean;
  /** Whether a symbol's location is somewhere the diff on screen can show. */
  inDiff: (symbol: LspSymbol) => boolean;
}

export function CommandPalette({
  open,
  query,
  onQuery,
  onClose,
  matches,
  current,
  onPickMatch,
  onPickSymbol,
  symbolsAvailable,
  inDiff,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const symbolMode = query.startsWith("@");
  const term = symbolMode ? query.slice(1).trim() : query;

  const [symbols, setSymbols] = useState<LspSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);

  // Focus without selecting: the palette can open with a prefix already in it
  // (`@` for symbol mode), and the dialog's own autofocus leaves that prefix
  // selected, so the next keystroke would eat it. Run after that, and put the
  // caret at the end.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Text mode reopens on the hit the reader left off at; symbol mode has no
  // such memory, because its list is rebuilt from scratch on every keystroke.
  useEffect(() => {
    if (open && !symbolMode) setSelected(current);
    // Only on open: tracking `current` here would fight the arrow keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Symbol lookups go over the wire, so they wait for a pause in typing. Text
  // search does not: it is a scan of what the page already has.
  useEffect(() => {
    if (!symbolMode || !symbolsAvailable || term.length < 2) {
      setSymbols([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let live = true;
    const timer = setTimeout(() => {
      void fetchSymbols(term).then((result) => {
        if (!live) return;
        setSymbols(result);
        setSelected(0);
        setLoading(false);
      });
    }, SYMBOL_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term, symbolMode, symbolsAvailable]);

  const ranked = useMemo(() => {
    const scored = symbols.map((symbol, i) => ({ symbol, i, here: inDiff(symbol) }));
    scored.sort((a, b) => Number(b.here) - Number(a.here) || a.i - b.i);
    return scored;
  }, [symbols, inDiff]);

  const visible = useMemo(
    () => (symbolMode ? ranked.length : Math.min(matches.length, MAX_TEXT_RESULTS)),
    [symbolMode, ranked.length, matches.length],
  );

  useEffect(() => {
    if (selected >= visible) setSelected(visible === 0 ? 0 : visible - 1);
  }, [visible, selected]);

  // Keep the cursor in view without yanking the list around when it already is.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);

  const choose = (index: number) => {
    if (symbolMode) {
      const symbol = ranked[index]?.symbol;
      if (symbol) onPickSymbol(symbol);
      return;
    }
    if (matches[index]) onPickMatch(index);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setSelected((i) => (visible === 0 ? 0 : (i + 1) % visible));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setSelected((i) => (visible === 0 ? 0 : (i - 1 + visible) % visible));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(selected);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Find</DialogTitle>
        <DialogDescription className="sr-only">Search the diff, or type @ for a symbol</DialogDescription>
        <div className="flex items-center gap-2.5 px-4 py-2.5">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find in the diff, or @ for a symbol"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm shadow-none ring-0 outline-hidden
              focus:border-0 focus:shadow-none focus:ring-0 focus:outline-hidden
              focus-visible:ring-0 focus-visible:outline-hidden
              placeholder:text-muted-foreground"
          />
          {loading && <Spinner className="size-3.5 text-muted-foreground" />}
        </div>

        {query.length > 0 && (
          <>
            <div className="h-px bg-border/60" />
            {/* Ten rows exactly: 6px of lead-in plus 10 x 28px. Padding on the
                scroller itself would not clip, so the eleventh row would bleed
                through it as a sliver and read as a rendering accident. */}
            <div ref={listRef} className="max-h-[286px] overflow-y-auto">
              <div className="p-1.5">
              {symbolMode ? (
                <SymbolResults
                  symbols={ranked}
                  available={symbolsAvailable}
                  term={term}
                  loading={loading}
                  selected={selected}
                  onHover={setSelected}
                  onChoose={choose}
                />
              ) : (
                <TextResults
                  matches={matches}
                  query={query}
                  selected={selected}
                  onHover={setSelected}
                  onChoose={choose}
                />
              )}
              </div>
            </div>
            <div className="h-px bg-border/60" />
            <Footer
              count={symbolMode ? symbols.length : matches.length}
              noun={symbolMode ? "symbol" : "hit"}
              truncated={!symbolMode && matches.length > MAX_TEXT_RESULTS}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------- rows */

function Row({
  selected,
  onHover,
  onChoose,
  children,
}: {
  selected: boolean;
  onHover: () => void;
  onChoose: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-selected={selected}
      onMouseMove={onHover}
      onClick={onChoose}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1 text-left ${
        selected ? "bg-muted" : ""
      }`}
    >
      {children}
    </button>
  );
}

/**
 * A path, cropped at the front. `direction: rtl` puts the ellipsis on the side
 * that matters least; `unicode-bidi: plaintext` keeps the slashes from being
 * reordered along with it.
 */
function Path({ path, line }: { path: string; line?: number | null }) {
  return (
    <span
      title={line == null ? path : `${path}:${line}`}
      className="flex min-w-0 flex-1 items-baseline justify-end font-mono text-[11px] leading-5 text-muted-foreground"
    >
      <span dir="rtl" className="truncate text-left">
        {path}
      </span>
      {line != null && <span className="shrink-0">:{line}</span>}
    </span>
  );
}

/**
 * The part of a line worth showing: from a little before the hit to the end.
 * A hit two hundred characters in would otherwise be cropped away by the very
 * truncation that keeps the row to one line.
 */
const LEAD = 12;

function windowed(match: Match, query: string): { text: string; query: string } {
  const text = match.text.replace(/\s+$/, "");
  const indent = text.length - text.trimStart().length;
  const from = Math.max(indent, match.start - LEAD);
  if (from <= indent) return { text: text.slice(indent), query };
  return { text: `\u2026${text.slice(from)}`, query };
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach((range, i) => {
    if (range.start > at) out.push(text.slice(at, range.start));
    out.push(
      <mark key={i} className="search-hit font-semibold">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-5 text-center text-xs text-muted-foreground">{children}</div>;
}

function TextResults({
  matches,
  query,
  selected,
  onHover,
  onChoose,
}: {
  matches: Match[];
  query: string;
  selected: number;
  onHover: (i: number) => void;
  onChoose: (i: number) => void;
}) {
  if (matches.length === 0) return <Empty>Nothing in the diff matches.</Empty>;
  return (
    <>
      {matches.slice(0, MAX_TEXT_RESULTS).map((match, i) => (
        <Row
          key={`${match.path}:${match.hunkIndex}:${match.lineIndex}:${match.start}`}
          selected={i === selected}
          onHover={() => onHover(i)}
          onChoose={() => onChoose(i)}
        >
          <span
            className={`w-2 shrink-0 text-center font-mono text-xs leading-5 ${
              match.kind === "add"
                ? "text-green-500"
                : match.kind === "del"
                  ? "text-red-500"
                  : "text-muted-foreground"
            }`}
          >
            {match.kind === "add" ? "+" : match.kind === "del" ? "−" : ""}
          </span>
          {/* One line per hit: a list of hits is scanned, not read, and a row
              that wraps costs the next hit its place on screen. */}
          <span className="min-w-0 flex-[3] truncate font-mono text-xs leading-5">
            <Highlighted {...windowed(match, query)} />
          </span>
          <Path path={match.path} line={match.number} />
        </Row>
      ))}
    </>
  );
}

function SymbolResults({
  symbols,
  available,
  term,
  loading,
  selected,
  onHover,
  onChoose,
}: {
  symbols: Array<{ symbol: LspSymbol; here: boolean }>;
  available: boolean;
  term: string;
  loading: boolean;
  selected: number;
  onHover: (i: number) => void;
  onChoose: (i: number) => void;
}) {
  if (!available) return <Empty>No language server is answering, so there is no symbol index.</Empty>;
  if (symbols.length === 0) {
    if (term.length < 2) return <Empty>Keep typing.</Empty>;
    return <Empty>{loading ? "Looking." : "Nothing found."}</Empty>;
  }
  return (
    <>
      {symbols.map(({ symbol, here }, i) => (
        <Row
          key={`${symbol.location.path}:${symbol.location.start.line}:${symbol.name}`}
          selected={i === selected}
          onHover={() => onHover(i)}
          onChoose={() => onChoose(i)}
        >
          <KindPill kind={symbol.kind} />
          {/* A name is the whole answer, so it never gets an ellipsis. */}
          <span className="min-w-0 flex-[2] break-all font-mono text-xs leading-5">
            {symbol.name}
            {symbol.container && (
              <span className="ml-1.5 text-[11px] text-muted-foreground">{symbol.container}</span>
            )}
          </span>
          {/* Symbol search reaches past the diff by design, so say which of
              these the diff can actually take you to. */}
          {here && (
            <span
              title="this one is in the diff on screen"
              className="shrink-0 rounded bg-sky-100 dark:bg-sky-950 px-1 text-[9px] font-semibold uppercase leading-5 tracking-wide text-sky-700 dark:text-sky-300"
            >
              in diff
            </span>
          )}
          <Path path={symbol.location.path} line={symbol.location.start.line + 1} />
        </Row>
      ))}
    </>
  );
}

/* --------------------------------------------------------------------- kind */

/**
 * The colour a symbol's kind gets is the colour that symbol has in the code
 * below: functions violet, types rose, values blue, modules green. The palette
 * is the one in index.css, so a pill and the token it points at agree.
 */
const KIND_CLASS: Record<string, string> = {
  function: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  method: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  constructor: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",

  class: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  interface: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  struct: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  enum: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "type parameter": "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",

  variable: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  constant: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  property: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  field: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  "enum member": "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",

  module: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  namespace: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  package: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  file: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
};

/** Two or three letters, because a pill of even width keeps names aligned. */
const KIND_SHORT: Record<string, string> = {
  function: "fn",
  method: "fn",
  constructor: "new",
  class: "cls",
  interface: "int",
  struct: "str",
  enum: "enum",
  "enum member": "enum",
  "type parameter": "typ",
  variable: "var",
  constant: "cst",
  property: "prop",
  field: "fld",
  module: "mod",
  namespace: "ns",
  package: "pkg",
  file: "file",
};

function KindPill({ kind }: { kind: string }) {
  const tone = KIND_CLASS[kind] ?? "bg-muted text-muted-foreground";
  return (
    <span
      title={kind}
      className={`w-9 shrink-0 rounded text-center font-mono text-[9px] font-semibold uppercase leading-5 tracking-wide ${tone}`}
    >
      {KIND_SHORT[kind] ?? kind.slice(0, 4)}
    </span>
  );
}

/* ------------------------------------------------------------------- footer */

function Footer({
  count,
  noun,
  truncated,
}: {
  count: number;
  noun: string;
  truncated: boolean;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-1.5 text-[11px] text-muted-foreground">
      <Hint keys="↑↓">navigate</Hint>
      <Hint keys="↵">open</Hint>
      <Hint keys="esc">close</Hint>
      <span className="flex-1" />
      <span className="tabular-nums">
        {count} {noun}
        {count === 1 ? "" : "s"}
        {truncated && ", showing the first 200"}
      </span>
    </div>
  );
}

function Hint({ keys, children }: { keys: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="font-sans text-foreground/70">{keys}</kbd>
      {children}
    </span>
  );
}
