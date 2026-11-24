import { Spinner } from "@/components/ui/spinner";
import { useLayoutEffect, useRef, useState } from "react";
import type { LspHover } from "../../../src/types.ts";
import { highlightLine } from "../lib/highlight.ts";

export interface HoverTarget {
  /** Viewport rectangle of the token the card belongs to. */
  rect: DOMRect;
  path: string;
  hover: LspHover | null;
  loading: boolean;
}

const MARGIN = 8;
const MAX_WIDTH = 620;

/**
 * The type under the cursor.
 *
 * Positioned against the token rather than the pointer, so the card does not
 * drift while you read it, and flipped above the line when there is no room
 * below. It is deliberately not interactive: anything you would click in it is
 * a keystroke or a modifier-click on the code itself.
 */
export function HoverCard({ target }: { target: HoverTarget }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(MARGIN, target.rect.left),
      Math.max(MARGIN, window.innerWidth - box.width - MARGIN),
    );
    const below = target.rect.bottom + MARGIN;
    const fitsBelow = below + box.height < window.innerHeight - MARGIN;
    const top = fitsBelow ? below : Math.max(MARGIN, target.rect.top - box.height - MARGIN);
    setPlacement({ left, top });
  }, [target]);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 max-h-[50vh] overflow-hidden rounded-xl border border-border bg-background px-3 py-2 shadow-lg"
      style={{
        maxWidth: MAX_WIDTH,
        left: placement?.left ?? target.rect.left,
        top: placement?.top ?? target.rect.bottom + MARGIN,
        // Measured before it is placed, so it is invisible for that one frame.
        visibility: placement ? "visible" : "hidden",
      }}
    >
      {target.loading && !target.hover ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> asking the language server
        </span>
      ) : target.hover ? (
        <>
          <Markdown text={target.hover.markdown} />
          <div className="pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {target.hover.server}
          </div>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">No type information here.</span>
      )}
    </div>
  );
}

/**
 * Just enough markdown for hover contents, which in practice are fenced code
 * blocks with prose between them. A real markdown renderer would be a lot of
 * bytes for text that is mostly a type signature.
 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, i) => {
        if (i % 2 === 1) {
          const newline = block.indexOf("\n");
          const language = newline === -1 ? block.trim() : block.slice(0, newline).trim();
          const code = newline === -1 ? "" : block.slice(newline + 1).replace(/\n$/, "");
          if (!code) return null;
          return (
            <pre
              key={i}
              className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5"
            >
              {code.split("\n").map((line, n) => (
                <div
                  key={n}
                  dangerouslySetInnerHTML={{
                    __html: highlightLine(line, language || "typescript") || "&nbsp;",
                  }}
                />
              ))}
            </pre>
          );
        }
        const prose = block.replace(/^\s*[-*]{3,}\s*$/gm, "").trim();
        if (!prose) return null;
        return (
          <p key={i} className="m-0 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
            {prose}
          </p>
        );
      })}
    </div>
  );
}
