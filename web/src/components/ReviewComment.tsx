import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import type { ReviewComment } from "../../../src/types.ts";
import { lineLabel } from "../lib/review.ts";

/**
 * The text box for a new or edited comment. ⌘ Enter saves and Escape cancels,
 * the two keys every review tool has taught people's fingers.
 */
export function CommentComposer({
  initial = "",
  label,
  onSave,
  onCancel,
}: {
  initial?: string;
  label: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = body.trim();
  const save = () => {
    if (trimmed) onSave(trimmed);
  };

  return (
    <div className="flex flex-col gap-2 font-sans" onClick={(e) => e.stopPropagation()}>
      <Textarea
        ref={ref}
        value={body}
        rows={3}
        className="min-h-20 resize-y bg-background text-sm"
        placeholder="Leave a comment"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="xs" variant="default" disabled={!trimmed} onClick={save}>Comment</Button>
      </div>
    </div>
  );
}

/** A saved comment, editable in place. */
export function CommentCard({
  comment,
  onUpdate,
  onRemove,
  showLocation = false,
}: {
  comment: ReviewComment;
  onUpdate: (id: string, body: string) => void;
  onRemove: (id: string) => void;
  showLocation?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentComposer
        initial={comment.body}
        label={lineLabel(comment)}
        onSave={(body) => {
          onUpdate(comment.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div
      data-comment-id={comment.id}
      className="group/comment rounded-xl border border-border bg-background px-3 py-2 font-sans"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">You</span>
        {showLocation && <span className="font-mono">{lineLabel(comment)}</span>}
        <span className="flex-1" />
        <span className="flex gap-1 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
          <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          <Button size="xs" variant="ghost" onClick={() => onRemove(comment.id)}>Delete</Button>
        </span>
      </div>
      <p className="m-0 whitespace-pre-wrap break-words pt-1 text-sm text-foreground">{comment.body}</p>
    </div>
  );
}
