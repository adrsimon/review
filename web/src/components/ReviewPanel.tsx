import { ChevronDownIcon, CircleCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReviewComment, ReviewVerdict, TrainingInfo } from "../../../src/types.ts";
import { lineLabel, type Review } from "../lib/review.ts";

const VERDICTS: Array<[ReviewVerdict, string]> = [
  ["approve", "Approve"],
  ["request_changes", "Request changes"],
  ["comment", "Comment only"],
];

/**
 * Where a review is finished: every comment in one list, the summary, the
 * verdict, and the button that hands it to the grader.
 */
export function ReviewPanel({
  open,
  onOpenChange,
  training,
  review,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  training: TrainingInfo;
  review: Review;
  onJump: (comment: ReviewComment) => void;
}) {
  const { state } = review;
  // The summary is typed here and saved debounced; keeping a local copy stops
  // the caret from jumping when the saved value comes back.
  const [summary, setSummary] = useState(state.summary);
  useEffect(() => {
    if (open) setSummary(review.state.summary);
    // Only on open: while typing, the local copy leads.
  }, [open]);

  const byFile = new Map<string, ReviewComment[]>();
  for (const c of state.comments) {
    const list = byFile.get(c.path) ?? [];
    list.push(c);
    byFile.set(c.path, list);
  }
  const done = state.submittedAt !== null;
  const canSubmit = state.verdict !== null && (state.comments.length > 0 || summary.trim() !== "");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>Your review</SheetTitle>
          <SheetDescription>Comments, summary and verdict for #{training.number}.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold m-0">
                Comments <span className="text-muted-foreground">{state.comments.length}</span>
              </h3>
              {state.comments.length === 0 && (
                <p className="m-0 text-sm text-muted-foreground">
                  Hover a line number and click + to comment. Drag the + across lines to comment
                  on a range.
                </p>
              )}
              {Array.from(byFile.entries()).map(([path, comments]) => (
                <div key={path} className="flex flex-col gap-1">
                  <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
                  {comments.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-muted"
                      onClick={() => onJump(c)}
                    >
                      <span className="w-20 flex-none font-mono text-xs text-muted-foreground">
                        {lineLabel(c)}
                      </span>
                      <span className="line-clamp-2 whitespace-pre-wrap">{c.body}</span>
                    </button>
                  ))}
                </div>
              ))}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold m-0">Summary</h3>
              <Textarea
                value={summary}
                rows={5}
                className="min-h-28 resize-y text-sm"
                placeholder="What should the author take away from this review?"
                onChange={(e) => {
                  setSummary(e.target.value);
                  review.setSummary(e.target.value);
                }}
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold m-0">Verdict</h3>
              <RadioGroup
                value={state.verdict ?? ""}
                onValueChange={(v: string) => review.setVerdict(v as ReviewVerdict)}
              >
                {VERDICTS.map(([value, label]) => (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={`verdict-${value}`} value={value} />
                    <Label htmlFor={`verdict-${value}`} className="font-normal">
                      {label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </section>

            <section className="flex flex-col gap-2">
              {done ? (
                <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted p-3 text-sm">
                  <span className="flex items-center gap-1.5 font-medium">
                    <CircleCheckIcon className="size-4 text-green-600 dark:text-green-400" />
                    Review submitted
                  </span>
                  <span className="text-muted-foreground">
                    Go back to your agent and run{" "}
                    <code className="font-mono">{training.commitCommand}</code> to get it graded.
                    Editing anything here reopens the review.
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="default" disabled={!canSubmit} onClick={() => {
                      // The summary may still be waiting on its debounce.
                      review.setSummary(summary);
                      review.submit();
                    }}>Finish review</Button>
                  {!canSubmit && (
                    <span className="text-xs text-muted-foreground">
                      Pick a verdict, and write at least one comment or a summary.
                    </span>
                  )}
                </div>
              )}
              {review.error && <Badge variant="warning" size="sm">{review.error}</Badge>}
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Height of the description preview before it has to be expanded, in px. */
const PREVIEW_HEIGHT = 160;

/**
 * The pull request as its reviewers first saw it: title and description,
 * nothing else. A long description shows as a clipped preview that fades out
 * over a "show more" bar, rather than a scroll box inside the scrolling page,
 * which is easy to miss and fights the wheel.
 */
export function PullRequestBanner({ training }: { training: TrainingInfo }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = training.body.trim();

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > PREVIEW_HEIGHT + 24);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, body]);

  const clipped = overflows && !expanded;

  return (
    <section className="mb-4 overflow-hidden rounded-xl border bg-card">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-mono text-sm text-muted-foreground">#{training.number}</span>
        <span className="flex-1 text-base font-semibold">{training.title}</span>
        {training.baseRef && (
          <Badge variant="muted" size="sm" className="font-mono">
            into {training.baseRef}
          </Badge>
        )}
        <ChevronDownIcon
          className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open && (
        <div className="relative border-t">
          <div
            ref={bodyRef}
            className="overflow-hidden px-4 py-3 text-sm break-words whitespace-pre-wrap"
            style={clipped ? { maxHeight: PREVIEW_HEIGHT } : undefined}
          >
            {body || <span className="text-muted-foreground">No description.</span>}
          </div>
          {clipped && (
            <div className="pointer-events-none absolute inset-x-0 bottom-9 h-16 bg-gradient-to-b from-transparent to-card" />
          )}
          {overflows && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex h-9 w-full items-center justify-center gap-1 border-t text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {expanded ? "Show less" : "Show full description"}
              <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
