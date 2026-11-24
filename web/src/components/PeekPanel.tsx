import { ChevronLeftIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tip } from "@/components/ui/tip";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LspLocation } from "../../../src/types.ts";
import { highlightLine, languageFor } from "../lib/highlight.ts";
import { fetchSource } from "../lib/lsp.ts";

/**
 * Where a symbol lives.
 *
 * Definitions, references and symbol search all land somewhere the diff does
 * not necessarily go — another file, another package, a .d.ts in node_modules.
 * Rather than teach the diff to render files it is not diffing, they open here,
 * on top, so following a symbol never costs you your place in the review.
 */

export type Peek =
  | { kind: "location"; title: string; location: LspLocation }
  | { kind: "list"; title: string; locations: LspLocation[] };

const CONTEXT_LINES = 24;

export interface PeekPanelProps {
  peek: Peek | null;
  onClose: () => void;
  /** Paths that are part of the diff, so the panel can offer to jump there. */
  /** Whether the diff on screen can show this location at all. */
  inDiff: (location: LspLocation) => boolean;
  /** Put a location on screen in the diff itself; false when it cannot be. */
  onShow: (location: LspLocation) => boolean;
}

export function PeekPanel({ peek, onClose, inDiff, onShow }: PeekPanelProps) {
  // A location picked out of a list, which the back arrow returns from.
  const [drilled, setDrilled] = useState<LspLocation | null>(null);

  useEffect(() => {
    setDrilled(null);
  }, [peek]);

  const showing = peek?.kind === "location" ? peek.location : drilled;

  return (
    <Sheet open={peek !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetDescription className="sr-only">Source for the selected symbol</SheetDescription>
          <SheetTitle>
            <span className="flex items-center gap-2">
              {drilled && (
                <Tip content="Back to the list"><Button size="icon-xs" variant="ghost" onClick={() => setDrilled(null)} aria-label="Back to the list"><ChevronLeftIcon /></Button></Tip>
              )}
              <span className="truncate">{peek?.title ?? ""}</span>
              <span className="flex-1" />
              {showing && inDiff(showing) && (
                <Button size="xs" variant="outline" onClick={() => {
                    onShow(showing);
                    onClose();
                  }}>show in diff</Button>
              )}
              <Tip content="Close"><Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close"><XIcon /></Button></Tip>
            </span>
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!peek ? null : showing ? (
            <Source location={showing} />
          ) : (
            <LocationList
              locations={peek.kind === "list" ? peek.locations : []}
              onPick={setDrilled}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function shortPath(location: LspLocation): string {
  if (!location.external) return location.path;
  // An absolute path into a package reads better from the package name on.
  const at = location.path.lastIndexOf("/node_modules/");
  return at === -1 ? location.path : location.path.slice(at + "/node_modules/".length);
}

function LocationList({
  locations,
  onPick,
}: {
  locations: LspLocation[];
  onPick: (location: LspLocation) => void;
}) {
  if (locations.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">Nothing found.</div>;
  }
  // Grouped by file, because a list of thirty hits in four files reads as four
  // things rather than thirty.
  const groups = new Map<string, LspLocation[]>();
  for (const location of locations) {
    const key = shortPath(location);
    const list = groups.get(key) ?? [];
    list.push(location);
    groups.set(key, list);
  }
  return (
    <div className="flex flex-col gap-4">
      {Array.from(groups, ([file, hits]) => (
        <div key={file} className="flex flex-col gap-1">
          <div className="font-mono text-xs text-muted-foreground">
            {file}
            <span className="pl-2">
              {hits.length} hit{hits.length === 1 ? "" : "s"}
            </span>
          </div>
          {hits.map((hit, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(hit)}
              className="flex w-full items-baseline gap-3 rounded-lg px-2 py-1 text-left hover:bg-muted"
            >
              <span className="w-10 flex-none text-right font-mono text-xs text-muted-foreground">
                {hit.start.line + 1}
              </span>
              <span className="truncate font-mono text-xs">{hit.preview ?? ""}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Source({ location }: { location: LspLocation }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [missing, setMissing] = useState(false);
  const targetRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    setLines(null);
    setMissing(false);
    let live = true;
    void fetchSource(location.path).then((result) => {
      if (!live) return;
      if (result) setLines(result);
      else setMissing(true);
    });
    return () => {
      live = false;
    };
  }, [location.path]);

  useLayoutEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [lines, location]);

  if (missing) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Could not read {shortPath(location)}.
      </div>
    );
  }
  if (!lines) {
    return (
      <div className="flex justify-center p-12">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  const lang = languageFor(location.path);
  const from = Math.max(0, location.start.line - CONTEXT_LINES);
  const to = Math.min(lines.length, location.end.line + CONTEXT_LINES + 1);

  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-xs text-muted-foreground">
        {shortPath(location)}:{location.start.line + 1}
      </div>
      <table className="w-full border-collapse font-mono text-xs leading-5" style={{ tabSize: 2 }}>
        <tbody>
          {lines.slice(from, to).map((text, i) => {
            const number = from + i;
            const target = number >= location.start.line && number <= location.end.line;
            return (
              <tr key={number} ref={target && number === location.start.line ? targetRef : null}>
                <td className="w-[1%] select-none whitespace-nowrap border-r border-border/60 px-2 text-right align-top text-muted-foreground">
                  {number + 1}
                </td>
                <td
                  className={`whitespace-pre-wrap break-words px-2.5 align-top ${
                    target ? "diff-add-bg" : ""
                  }`}
                  dangerouslySetInnerHTML={{ __html: highlightLine(text, lang) || "&nbsp;" }}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      {to < lines.length && (
        <div className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
          <ChevronLeftIcon className="size-3 rotate-90" />
          {lines.length - to} more line{lines.length - to === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
