import { ChevronRightIcon, FolderIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DiffFile } from "../../../src/types.ts";
import type { Viewed } from "../lib/viewed.ts";
import { buildTree, type Node } from "../lib/tree.ts";
import { STATUS_DOT } from "./DiffFileView.tsx";

export interface FileTreeProps {
  files: DiffFile[];
  currentPath: string | null;
  viewed: Viewed;
  onSelect: (path: string) => void;
  /** Find-in-diff hits per file, or null when nothing is being searched. */
  matchCounts: Map<string, number> | null;
}

function Counts({
  file,
  changed,
  hits,
}: {
  file: DiffFile;
  changed: boolean;
  hits: number | null;
}) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap pl-2 font-mono text-[10px] text-muted-foreground">
      {changed && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="changed since you read it" />}
      {hits === null ? (
        <>
          +{file.additions} -{file.deletions}
        </>
      ) : (
        <span className="text-foreground">{hits} hit{hits === 1 ? "" : "s"}</span>
      )}
    </span>
  );
}

export function FileTree({ files, currentPath, viewed, onSelect, matchCounts }: FileTreeProps) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    // A search in progress narrows the tree to the files that have hits, which
    // is the same answer the file filter gives, asked about content instead.
    const withHits = matchCounts ? files.filter((f) => matchCounts.has(f.path)) : files;
    const needle = filter.trim().toLowerCase();
    if (!needle) return withHits;
    return withHits.filter((f) => f.path.toLowerCase().includes(needle));
  }, [files, filter, matchCounts]);

  const tree = useMemo(() => buildTree(visible), [visible]);

  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggleDir = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNodes = (node: Node, depth: number): React.ReactNode =>
    node.children.map((child) => {
      const indent = { paddingLeft: `${depth * 12 + 6}px` };
      if (child.file) {
        const file = child.file;
        const selected = file.path === currentPath;
        return (
          <li key={file.path}>
            <button
              type="button"
              id={`tree-${file.path}`}
              style={indent}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(file.path)}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-md pr-1.5 text-left text-sm transition-colors hover:bg-foreground/5",
                selected && "bg-foreground/10 font-medium",
              )}
            >
              <span className={`size-2 flex-none rounded-xs ${STATUS_DOT[file.status]}`} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  viewed.isViewed(file) && "text-muted-foreground line-through opacity-60",
                )}
              >
                {child.name}
              </span>
              <Counts
                file={file}
                changed={viewed.hasChangedSinceRead(file)}
                hits={matchCounts?.get(file.path) ?? null}
              />
            </button>
          </li>
        );
      }
      const open = !closed.has(child.path);
      return (
        <li key={`dir:${child.path}`}>
          <button
            type="button"
            style={indent}
            aria-expanded={open}
            onClick={() => toggleDir(child.path)}
            className="flex h-7 w-full items-center gap-1.5 rounded-md pr-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ChevronRightIcon className={cn("size-3.5 flex-none transition-transform", open && "rotate-90")} />
            <FolderIcon className="size-3.5 flex-none" />
            <span className="truncate">{child.name}</span>
          </button>
          {open && <ul>{renderNodes(child, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="file-filter"
          name="file-filter"
          placeholder="Filter files"
          autoComplete="off"
          spellCheck={false}
          className="h-8 bg-background pr-7 pl-8 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter("");
              e.currentTarget.blur();
            }
            e.stopPropagation();
          }}
        />
        {filter && (
          <button
            type="button"
            aria-label="Clear the filter"
            onClick={() => setFilter("")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="px-2 py-4 text-sm text-muted-foreground">
          {matchCounts ? "No file has a hit." : "No files match."}
        </div>
      ) : (
        <ul className="flex flex-col">{renderNodes(tree, 0)}</ul>
      )}
    </div>
  );
}
