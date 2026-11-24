import { MessageSquareIcon, MoonIcon, SearchIcon, SunIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tip } from "@/components/ui/tip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffFile, DiffPayload, LspLocation, LspSymbol, ReviewComment } from "../../src/types.ts";
import { clearFileCache, fetchCommit, fetchDiff, fetchFile, subscribe } from "./lib/api.ts";
import { useDiagnostics } from "./lib/language.ts";
import { clearSourceCache, fetchDefinition, fetchHover, fetchReferences, useLspStatus } from "./lib/lsp.ts";
import { codePointAt, tokenRect, type CodePoint } from "./lib/position.ts";
import { countByFile, findMatches, sameMatch, type Match } from "./lib/search.ts";
import { useTheme } from "./lib/theme.ts";
import { useViewed } from "./lib/viewed.ts";
import { CommitList } from "./components/CommitList.tsx";
import { DiffFileView } from "./components/DiffFileView.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { inTreeOrder } from "./lib/tree.ts";
import { HelpDialog } from "./components/HelpDialog.tsx";
import { HoverCard, type HoverTarget } from "./components/HoverCard.tsx";
import { PeekPanel, type Peek } from "./components/PeekPanel.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { PullRequestBanner, ReviewPanel } from "./components/ReviewPanel.tsx";
import type { CommentingProps } from "./components/DiffFileView.tsx";
import { recordTelemetry, useReview } from "./lib/review.ts";

type Mode = "split" | "unified";
function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>(() => {
    const stored = localStorage.getItem("review:mode");
    return stored === "unified" || stored === "split" ? stored : "split";
  });
  const set = useCallback((m: Mode) => {
    localStorage.setItem("review:mode", m);
    setMode(m);
  }, []);
  return [mode, set];
}

const NO_COMMENTS: ReviewComment[] = [];
const OPEN_DWELL_MS = 2000;

/** How long the pointer has to sit still before we ask what is under it. */
const HOVER_DELAY_MS = 350;

export function App() {
  const [payload, setPayload] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useMode();
  const [theme, toggleTheme] = useTheme();
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Files forced open despite being cleared, because something pointed at them.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [hideViewed, setHideViewed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Updates for the file being read wait here rather than moving it under the reader.
  const [pending, setPending] = useState<Map<string, DiffFile>>(new Map());
  const mainRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<string | null>(null);
  const anchorRef = useRef<{ path: string; top: number } | null>(null);

  const lspStatus = useLspStatus();
  // The diff pane only exists once there is a diff, so anything that listens on
  // it has to wait for that as well as for the language servers.
  const lspLive = (lspStatus?.enabled ?? false) && payload !== null;

  useEffect(() => {
    currentRef.current = currentPath;
  }, [currentPath]);

  /**
   * Whether an incoming update should wait. Only the file the reader is looking
   * at, and only while its rows are actually on screen: a collapsed or cleared
   * file has nothing to disturb, so holding its update back would just leave the
   * reader looking at a version the repository no longer has.
   */
  const deferRef = useRef<(path: string) => boolean>(() => false);

  useEffect(() => {
    fetchDiff()
      .then(setPayload)
      .catch((err: Error) => setError(err.message));
  }, []);

  /** Swap a file in place, remembering where the reader was looking. */
  const applyFile = useCallback((next: DiffFile) => {
    const anchorPath = currentRef.current;
    if (anchorPath) {
      const el = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(anchorPath)}"]`);
      if (el) anchorRef.current = { path: anchorPath, top: el.getBoundingClientRect().top };
    }
    clearFileCache(next.path);
    setPayload((prev) => {
      if (!prev) return prev;
      const known = prev.files.some((f) => f.path === next.path);
      const files = known
        ? prev.files.map((f) => (f.path === next.path ? next : f))
        : [...prev.files, next].sort((a, b) => a.path.localeCompare(b.path));
      return { ...prev, files };
    });
  }, []);

  // The anchor is restored after the swapped rows have been laid out, so the
  // file the reader is on stays where it was even when a file above it grew.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const main = mainRef.current;
    const el = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(anchor.path)}"]`);
    if (!main || !el) return;
    const drift = el.getBoundingClientRect().top - anchor.top;
    if (drift !== 0) main.scrollTop += drift;
  }, [payload]);

  // Live worktree updates. Only the commit view is static, so it opts out.
  useEffect(() => {
    if (selectedCommit !== null) return;
    return subscribe((event) => {
      // A file that moved may have moved what a definition points at too.
      clearSourceCache();
      for (const removed of event.removed) {
        setPayload((prev) =>
          prev ? { ...prev, files: prev.files.filter((f) => f.path !== removed) } : prev,
        );
      }
      for (const st of event.stamps) {
        void fetchFile(st.path)
          .then((file) => {
            if (deferRef.current(file.path)) {
              setPending((prev) => new Map(prev).set(file.path, file));
            } else {
              applyFile(file);
            }
          })
          .catch(() => {
            // The file left the diff between the event and the fetch.
          });
      }
    });
  }, [selectedCommit, applyFile]);

  /** Take the update that was held back while this file was on screen. */
  const flushPending = useCallback(
    (path: string) => {
      const file = pending.get(path);
      if (!file) return;
      setPending((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
      applyFile(file);
    },
    [pending, applyFile],
  );

  // Once the reader moves on, anything held back for the file they left applies.
  useEffect(() => {
    for (const path of pending.keys()) {
      if (path !== currentPath) flushPending(path);
    }
  }, [currentPath, pending, flushPending]);

  const loadCommit = useCallback((sha: string | null) => {
    setSelectedCommit(sha);
    setCollapsed(new Set());
    setRevealed(new Set());
    setPending(new Map());
    clearFileCache();
    const load = sha === null ? fetchDiff() : fetchCommit(sha);
    void load.then((next) => {
      setPayload(next);
      mainRef.current?.scrollTo({ top: 0 });
    });
  }, []);

  // Everything that walks the files (the diff pane, J and K) follows the
  // sidebar's order, so the two never disagree.
  const files = useMemo(() => inTreeOrder(payload?.files ?? []), [payload?.files]);

  const viewed = useViewed(payload?.repo ?? "", payload?.revs ?? ({} as never), files);

  /* -------------------------------------------------------------- training */

  const training = payload?.training ?? null;
  const review = useReview(training !== null);

  // One props object per file, rebuilt only when that file's comments change,
  // so a comment on one file does not re-render every other one.
  const commentingCache = useRef(new Map<string, CommentingProps>());
  const commentingFor = useCallback(
    (path: string): CommentingProps | null => {
      // Comments pin to line numbers of the whole range; a single commit's
      // diff numbers its lines differently, so it is read-only.
      if (!training || !review.ready || selectedCommit !== null) return null;
      const comments = review.byPath.get(path) ?? NO_COMMENTS;
      const cached = commentingCache.current.get(path);
      if (cached && cached.comments === comments) return cached;
      const next: CommentingProps = {
        comments,
        onAdd: review.add,
        onUpdate: review.update,
        onRemove: review.remove,
      };
      commentingCache.current.set(path, next);
      return next;
    },
    [training, review.ready, review.byPath, review.add, review.update, review.remove, selectedCommit],
  );

  // Which files the reviewer actually read is part of what gets graded. A file
  // only counts once the reader has stayed on it a moment: jumping to the last
  // file scrolls through every one in between.
  const opened = useRef(new Set<string>());
  useEffect(() => {
    if (!training || !currentPath || opened.current.has(currentPath)) return;
    const timer = window.setTimeout(() => {
      opened.current.add(currentPath);
      recordTelemetry({ path: currentPath, kind: "open" });
    }, OPEN_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [training, currentPath]);

  const toggleViewed = useCallback(
    (file: DiffFile) => {
      if (training) {
        recordTelemetry({ path: file.path, kind: viewed.isViewed(file) ? "unviewed" : "viewed" });
      }
      viewed.toggle(file);
    },
    [training, viewed],
  );

  const shown = useMemo(
    () => (hideViewed ? files.filter((f) => !viewed.isViewed(f)) : files),
    [files, hideViewed, viewed],
  );

  /** Cleared and collapsed both fold a file away; being revealed overrides both. */
  const isCollapsed = useCallback(
    (file: DiffFile) =>
      revealed.has(file.path) ? false : collapsed.has(file.path) || viewed.isViewed(file),
    [collapsed, revealed, viewed],
  );

  useEffect(() => {
    deferRef.current = (path: string) => {
      if (currentRef.current !== path) return false;
      const file = files.find((f) => f.path === path);
      if (!file) return false;
      return !isCollapsed(file);
    };
  }, [files, isCollapsed]);

  const diagnostics = useDiagnostics(shown, lspStatus, (file) => !isCollapsed(file));

  const totals = useMemo(
    () =>
      files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), {
        add: 0,
        del: 0,
      }),
    [files],
  );

  const scrollToFile = useCallback((path: string) => {
    const el = document.getElementById(`file-${path}`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    setCurrentPath(path);
    history.replaceState(null, "", `#${encodeURIComponent(path)}`);
  }, []);

  /** Open a file that is folded away and put it on screen. */
  const reveal = useCallback(
    (path: string) => {
      setRevealed((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
      setCollapsed((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      if (hideViewed) {
        const file = files.find((f) => f.path === path);
        if (file && viewed.isViewed(file)) setHideViewed(false);
      }
      requestAnimationFrame(() => scrollToFile(path));
    },
    [files, hideViewed, scrollToFile, viewed],
  );

  const toggleCollapse = useCallback((path: string) => {
    setRevealed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /* ------------------------------------------------------------------ find */

  const matches = useMemo(() => findMatches(shown, query), [shown, query]);
  const matchCounts = useMemo(() => countByFile(matches), [matches]);
  const activeMatch: Match | null = matches[matchIndex] ?? null;

  // A new query starts from the top rather than from wherever the old index was.
  useEffect(() => {
    setMatchIndex(0);
  }, [query]);

  // Walking hits has to open whatever the hit is hiding behind, then scroll to
  // it once the row exists.
  const lastJump = useRef<Match | null>(null);
  useEffect(() => {
    if (!activeMatch || sameMatch(activeMatch, lastJump.current)) return;
    lastJump.current = activeMatch;
    const file = files.find((f) => f.path === activeMatch.path);
    if (file && isCollapsed(file)) {
      reveal(activeMatch.path);
      return;
    }
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(activeMatch.path)}"] [data-match]`,
      );
      row?.scrollIntoView({ block: "center" });
    });
  }, [activeMatch, files, isCollapsed, reveal]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  // Choosing a hit closes the palette but keeps the query: the reader wants to
  // look at what they found, with the other hits still marked around it.
  const pickMatch = useCallback((index: number) => {
    setMatchIndex(index);
    setSearchOpen(false);
  }, []);

  /**
   * Whether the diff on screen can show this location itself. A file can be in
   * the diff without the line being in it: only the hunks are on the page, so a
   * symbol declared a hundred lines above the change is not there to scroll to.
   */
  const shownInDiff = useCallback(
    (location: LspLocation): boolean => {
      if (location.external) return false;
      const file = files.find((f) => f.path === location.path);
      if (!file) return false;
      const line = location.start.line + 1;
      return file.hunks.some((hunk) => hunk.lines.some((l) => l.newNumber === line));
    },
    [files],
  );

  /**
   * Land on a location in the diff: unfold whatever is hiding it, scroll the
   * line into view, and flash it so the eye knows where it was put. Returns
   * false when the diff cannot show it, which is the panel's cue.
   */
  const showInDiff = useCallback(
    (location: LspLocation): boolean => {
      if (!shownInDiff(location)) return false;
      reveal(location.path);
      const line = location.start.line + 1;
      // Two frames: one for the unfold, one for the rows it just laid out.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const cell = document.querySelector<HTMLElement>(
            `[data-code-path="${CSS.escape(location.path)}"][data-code-line="${line}"]`,
          );
          const row = cell?.closest("tr") ?? cell;
          if (!row) return;
          row.scrollIntoView({ block: "center" });
          row.classList.remove("line-flash");
          // Restart the animation rather than let a second jump to the same
          // line pass unnoticed.
          void row.offsetWidth;
          row.classList.add("line-flash");
        }),
      );
      return true;
    },
    [reveal, shownInDiff],
  );

  /**
   * Following a symbol reads better in place than in a panel: the diff is what
   * the reader is looking at, and a panel over it is a second place to look.
   * The panel is for what the diff cannot show — a definition in another file,
   * in node_modules, or outside the hunks on screen.
   */
  const openLocation = useCallback(
    (title: string, location: LspLocation) => {
      if (showInDiff(location)) {
        setPeek(null);
        return;
      }
      setPeek({ kind: "location", title, location });
    },
    [showInDiff],
  );

  const openSymbol = useCallback(
    (symbol: LspSymbol) => {
      setSearchOpen(false);
      setQuery("");
      openLocation(`${symbol.kind} ${symbol.name}`, symbol.location);
    },
    [openLocation],
  );

  /* ------------------------------------------------------- language answers */

  const hoverRef = useRef<{ timer: number; point: CodePoint | null }>({ timer: 0, point: null });

  const clearHover = useCallback(() => {
    if (hoverRef.current.timer) window.clearTimeout(hoverRef.current.timer);
    hoverRef.current = { timer: 0, point: null };
    setHover(null);
  }, []);

  // One listener for the whole diff. Per-token elements would be a lot of DOM
  // for a question most lines are never asked.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !lspLive) return;

    const onMove = (e: MouseEvent) => {
      if (e.buttons !== 0) return;
      const point = codePointAt(e.clientX, e.clientY);
      const previous = hoverRef.current.point;
      if (
        point &&
        previous &&
        point.path === previous.path &&
        point.position.line === previous.position.line &&
        point.token?.start === previous.token?.start
      ) {
        return; // same token, the card already says what it says
      }
      if (hoverRef.current.timer) window.clearTimeout(hoverRef.current.timer);
      setHover(null);
      if (!point?.token) {
        hoverRef.current = { timer: 0, point: null };
        return;
      }
      const timer = window.setTimeout(() => {
        const rect = tokenRect(point);
        setHover({ rect, path: point.path, hover: null, loading: true });
        void fetchHover(point.path, point.position).then((result) => {
          // The pointer may have moved on while the server was thinking.
          if (hoverRef.current.point !== point) return;
          setHover({ rect, path: point.path, hover: result, loading: false });
        });
      }, HOVER_DELAY_MS);
      hoverRef.current = { timer, point };
    };

    const onLeave = () => clearHover();
    main.addEventListener("mousemove", onMove);
    main.addEventListener("mouseleave", onLeave);
    main.addEventListener("scroll", onLeave, { passive: true });
    return () => {
      main.removeEventListener("mousemove", onMove);
      main.removeEventListener("mouseleave", onLeave);
      main.removeEventListener("scroll", onLeave);
      if (hoverRef.current.timer) window.clearTimeout(hoverRef.current.timer);
    };
  }, [lspLive, clearHover]);

  // Modifier clicks, the two questions worth a click: where is this from, and
  // who else uses it.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !lspLive) return;
    const onClick = (e: MouseEvent) => {
      const wantsDefinition = e.metaKey || e.ctrlKey;
      const wantsReferences = e.altKey;
      if (!wantsDefinition && !wantsReferences) return;
      const point = codePointAt(e.clientX, e.clientY);
      if (!point?.token) return;
      e.preventDefault();
      clearHover();
      const name = point.token.value;
      if (wantsDefinition) {
        setPeek({ kind: "list", title: `definition of ${name}`, locations: [] });
        void fetchDefinition(point.path, point.position).then((locations) => {
          if (locations.length === 1) {
            openLocation(`definition of ${name}`, locations[0]);
            return;
          }
          setPeek({ kind: "list", title: `definition of ${name}`, locations });
        });
        return;
      }
      setPeek({ kind: "list", title: `references to ${name}`, locations: [] });
      void fetchReferences(point.path, point.position).then((locations) => {
        setPeek({ kind: "list", title: `references to ${name}`, locations });
      });
    };
    main.addEventListener("click", onClick);
    return () => main.removeEventListener("click", onClick);
  }, [lspLive, clearHover, openLocation]);

  // Track which file the reader is on. Scrolling past a file no longer counts as
  // having read it: for a diff you did not write, that assumption is too generous.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || files.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = main.getBoundingClientRect().top;
      const sections = Array.from(main.querySelectorAll<HTMLElement>("[data-path]"));
      let current: string | null = null;
      for (const section of sections) {
        const path = section.dataset.path!;
        const rect = section.getBoundingClientRect();
        if (rect.top - top <= 12) current = path;
        else if (current === null) current = path;
      }
      if (current) setCurrentPath(current);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      main.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [files]);

  // Restore the file from the URL hash after a reload.
  useEffect(() => {
    if (!payload) return;
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash) requestAnimationFrame(() => scrollToFile(hash));
  }, [payload, scrollToFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // The palette is the one thing that opens from inside a field, because
      // it is the shortcut everybody's fingers already know.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuery("");
        setSearchOpen(true);
        return;
      }
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") {
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setShowHelp(false);
        setPeek(null);
        closeSearch();
        return;
      }
      if (e.key === "f" || e.key === "@") {
        e.preventDefault();
        setQuery(e.key === "@" ? "@" : "");
        setSearchOpen(true);
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("file-filter")?.focus();
        return;
      }
      if (e.key === "t") {
        toggleTheme();
        return;
      }
      if (e.key === "r" && training) {
        // The panel focuses its first field as it opens; keep the "r" out of it.
        e.preventDefault();
        setReviewOpen((v) => !v);
        return;
      }
      if (e.key === "s") {
        setMode(mode === "split" ? "unified" : "split");
        return;
      }
      if (e.key === "v" && currentPath) {
        const file = files.find((f) => f.path === currentPath);
        if (file) toggleViewed(file);
        return;
      }
      if (e.key === "c" && currentPath) {
        toggleCollapse(currentPath);
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const index = files.findIndex((f) => f.path === currentPath);
        const next = e.key === "j" ? index + 1 : index - 1;
        const file = files[next < 0 ? 0 : Math.min(next, files.length - 1)];
        if (file) scrollToFile(file.path);
        return;
      }
      if (e.key === "n" || e.key === "p") {
        e.preventDefault();
        const main = mainRef.current;
        if (!main) return;
        const anchors = Array.from(main.querySelectorAll<HTMLElement>("[data-hunk]"));
        const top = main.getBoundingClientRect().top;
        const positions = anchors.map((a) => a.getBoundingClientRect().top - top);
        const targetIndex =
          e.key === "n"
            ? positions.findIndex((p) => p > 4)
            : positions.reduce((acc, p, i) => (p < -4 ? i : acc), -1);
        anchors[targetIndex]?.scrollIntoView({ block: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    files,
    currentPath,
    mode,
    setMode,
    scrollToFile,
    toggleCollapse,
    toggleTheme,
    toggleViewed,
    closeSearch,
    training,
  ]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-sm text-muted-foreground">
        Could not load the diff: {error}
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const { revs } = payload;

  const jumpToComment = (comment: ReviewComment) => {
    setReviewOpen(false);
    reveal(comment.path);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(comment.id)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        el.classList.remove("line-flash");
        void el.offsetWidth;
        el.classList.add("line-flash");
      }),
    );
  };

  return (
    <div className="grid h-full grid-rows-[auto_1fr] bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2">
        <span className="text-base font-semibold">review</span>
        {training && <Badge variant="highlight" size="sm">review training</Badge>}
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="muted" size="sm" className="font-mono">
            {training ? `base ${revs.base.slice(0, 8)}` : revs.baseLabel}
          </Badge>
          to
          <Badge variant="muted" size="sm" className="font-mono">
            {training ? `as first reviewed ${revs.head.slice(0, 8)}` : revs.headLabel}
          </Badge>
        </span>
        <span className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"}{" "}
          <span className="font-semibold text-green-600 dark:text-green-400">+{totals.add}</span>{" "}
          <span className="font-semibold text-red-600 dark:text-red-400">-{totals.del}</span>
        </span>
        {files.length > 0 && (
          <Tip content={hideViewed ? "Show every file" : "Hide the files you have cleared"}><Button size="xs" variant={hideViewed ? "default" : "ghost"} onClick={() => setHideViewed((v) => !v)}>{`${viewed.count}/${files.length} viewed`}</Button></Tip>
        )}
        <span className="flex-1" />
        <Tip content="Find in the diff, or @ for a symbol"><Button size="icon-xs" variant="ghost" onClick={() => setSearchOpen(true)} aria-label="Find in the diff, or @ for a symbol"><SearchIcon /></Button></Tip>
        <LspBadge status={lspStatus} />
        {training && (
          <Tip content="Comments, summary and verdict (R)"><Button size="xs" variant={review.state.submittedAt ? "outline" : "default"} onClick={() => setReviewOpen(true)}><MessageSquareIcon />{
              review.state.submittedAt
                ? "Submitted"
                : `Review${review.state.comments.length ? ` · ${review.state.comments.length}` : ""}`
            }</Button></Tip>
        )}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as Mode)}
        >
          <ToggleGroupItem value="split" className="h-6 px-2 text-xs">
            split
          </ToggleGroupItem>
          <ToggleGroupItem value="unified" className="h-6 px-2 text-xs">
            unified
          </ToggleGroupItem>
        </ToggleGroup>
        <Tip content={theme === "dark" ? "Light theme" : "Dark theme"}><Button size="icon-xs" variant="ghost" onClick={toggleTheme} aria-label={theme === "dark" ? "Light theme" : "Dark theme"}>{theme === "dark" ? <SunIcon /> : <MoonIcon />}</Button></Tip>
        <Tip content="Keyboard"><Button size="xs" variant="ghost" onClick={() => setShowHelp(true)}>?</Button></Tip>
      </header>

      <div className="grid min-h-0 grid-cols-[320px_1fr]">
        <aside className="flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-border bg-muted p-2">
          {payload.commits.length > 0 && (
            <>
              <CommitList
                commits={payload.commits}
                selected={selectedCommit}
                onSelect={loadCommit}
              />
              <Separator />
            </>
          )}
          <FileTree
            files={shown}
            currentPath={currentPath}
            viewed={viewed}
            onSelect={scrollToFile}
            matchCounts={query && !query.startsWith("@") ? matchCounts : null}
          />
        </aside>

        <main className="min-h-0 overflow-y-auto" ref={mainRef}>
          <div className="p-4">
          {training && <PullRequestBanner training={training} />}
          {shown.length === 0 && (
            <div className="p-12 text-center text-sm text-muted-foreground">
              {files.length === 0 ? "No changes." : "Every file is marked viewed."}
            </div>
          )}
          {shown.map((file) => (
            <DiffFileView
              key={file.path}
              file={file}
              mode={mode}
              collapsed={isCollapsed(file)}
              onToggleCollapse={toggleCollapse}
              viewed={viewed.isViewed(file)}
              changedSinceRead={viewed.hasChangedSinceRead(file)}
              onToggleViewed={() => toggleViewed(file)}
              stale={pending.has(file.path)}
              onRefresh={() => flushPending(file.path)}
              diagnostics={diagnostics.for(file)}
              search={query.startsWith("@") ? "" : query}
              activeMatch={activeMatch}
              commenting={commentingFor(file.path)}
            />
          ))}
        </div>
        </main>
      </div>

      <CommandPalette
        open={searchOpen}
        query={query}
        onQuery={setQuery}
        onClose={closeSearch}
        matches={matches}
        current={matchIndex}
        onPickMatch={pickMatch}
        onPickSymbol={openSymbol}
        symbolsAvailable={lspStatus?.enabled ?? false}
        inDiff={(symbol) => shownInDiff(symbol.location)}
      />
      {hover && <HoverCard target={hover} />}
      <PeekPanel
        peek={peek}
        onClose={() => setPeek(null)}
        inDiff={shownInDiff}
        onShow={showInDiff}
      />
      <HelpDialog open={showHelp} onOpenChange={setShowHelp} />
      {training && (
        <ReviewPanel
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          training={training}
          review={review}
          onJump={jumpToComment}
        />
      )}
    </div>
  );
}

/** Whether language answers are on, and what to blame when they are not. */
function LspBadge({ status }: { status: ReturnType<typeof useLspStatus> }) {
  if (!status) return null;
  if (!status.enabled) {
    return (
      <span title={status.reason ?? "no language server"} className="text-xs text-muted-foreground">
        no lsp
      </span>
    );
  }
  const live = status.servers.filter((s) => s.state !== "missing" && s.state !== "failed");
  const detail = status.servers
    .map((s) => `${s.id}: ${s.state}${s.error ? ` (${s.error.split("\n")[0]})` : ""}`)
    .join("\n");
  return (
    <span title={detail} className="text-xs text-muted-foreground">
      {live.map((s) => s.id).join(" ")}
    </span>
  );
}
