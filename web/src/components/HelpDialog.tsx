import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

const SHORTCUTS: Array<[string, string]> = [
  ["J", "next file"],
  ["K", "previous file"],
  ["N", "next hunk"],
  ["P", "previous hunk"],
  ["/", "filter files"],
  ["\u2318 K", "command palette"],
  ["F", "palette, find in the diff"],
  ["@", "palette, find a symbol"],
  ["\u2318 click", "go to definition"],
  ["\u2325 click", "find references"],
  ["S", "split or unified"],
  ["V", "mark the current file viewed"],
  ["C", "collapse or expand the current file"],
  ["T", "light or dark"],
  ["R", "your review (training sessions)"],
  ["?", "this list"],
];

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
        </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
            {SHORTCUTS.map(([key, what]) => (
              <div key={key} className="contents">
                <dt>
                  <KbdGroup>
                    {key.split(" ").map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </KbdGroup>
                </dt>
                <dd className="m-0 text-sm text-muted-foreground">{what}</dd>
              </div>
            ))}
          </dl>
      </DialogContent>
    </Dialog>
  );
}
