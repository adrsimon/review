import { GitBranchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Commit } from "../../../src/types.ts";

export interface CommitListProps {
  commits: Commit[];
  selected: string | null;
  onSelect: (sha: string | null) => void;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CommitList({ commits, selected, onSelect }: CommitListProps) {
  if (commits.length === 0) return null;
  const item = (active: boolean) =>
    cn(
      "flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm transition-colors hover:bg-foreground/5",
      active && "bg-foreground/10 font-medium",
    );
  return (
    <nav className="flex w-full flex-col">
      <div className="px-1.5 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
        {commits.length} commit{commits.length === 1 ? "" : "s"}
      </div>
      <button type="button" className={item(selected === null)} onClick={() => onSelect(null)}>
        <GitBranchIcon className="size-3.5 flex-none text-muted-foreground" />
        <span className="truncate">All changes</span>
      </button>
      {commits.map((commit) => (
        <button
          type="button"
          key={commit.sha}
          className={item(selected === commit.sha)}
          onClick={() => onSelect(commit.sha)}
          title={`${commit.shortSha} · ${commit.author} · ${shortDate(commit.date)}`}
        >
          <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
          <span className="pl-2 font-mono text-[10px] text-muted-foreground">{commit.shortSha}</span>
        </button>
      ))}
    </nav>
  );
}
