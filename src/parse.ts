import { createHash } from "node:crypto";
import type { DiffFile, DiffLine, FileStatus, Hunk } from "./types.ts";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** git quotes paths containing unusual bytes; undo that so the UI shows real names. */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[++i];
    if (next >= "0" && next <= "7") {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else if (next === "n") bytes.push(10);
    else if (next === "t") bytes.push(9);
    else if (next === "r") bytes.push(13);
    else bytes.push(next.charCodeAt(0));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * Split the "diff --git a/x b/y" line. Paths can contain spaces, so we look for
 * the a/ + b/ pair that splits the remainder in two, preferring the quoted form.
 */
function parseGitHeader(line: string): { a: string; b: string } | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end < 0) return null;
    return { a: strip(unquotePath(rest.slice(0, end + 1))), b: strip(unquotePath(rest.slice(end + 2))) };
  }
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  if (a.slice(2) === b.slice(2)) return { a: strip(a), b: strip(b) };
  // Fall back to the first " b/" that yields a plausible split.
  const idx = rest.indexOf(" b/");
  if (idx < 0) return null;
  return { a: strip(rest.slice(0, idx)), b: strip(rest.slice(idx + 1)) };
}

function findQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

function strip(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Identity of a file's diff: same bytes in, same hash out. */
function hashFile(file: DiffFile): string {
  const h = createHash("sha1");
  h.update(file.path);
  h.update(file.status);
  h.update(String(file.binary));
  for (const hunk of file.hunks) {
    h.update(hunk.header);
    h.update(`${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}`);
    for (const line of hunk.lines) h.update(line.kind + line.text + "\n");
  }
  return h.digest("hex").slice(0, 16);
}

export function parsePatch(patch: string, maxLinesPerFile = 20000): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = patch.split("\n");
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const closeFile = () => {
    if (!file) return;
    file.large = file.additions + file.deletions > maxLinesPerFile;
    file.hash = hashFile(file);
    files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      closeFile();
      const header = parseGitHeader(line);
      const path = header ? header.b : "unknown";
      file = {
        path,
        hash: "",
        oldPath: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        large: false,
        image: IMAGE_EXT.test(path),
        oldTotal: null,
        newTotal: null,
        hunks: [],
      };
      if (header && header.a !== header.b) file.oldPath = header.a;
      continue;
    }
    if (!file) continue;

    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.oldPath = unquotePath(line.slice("rename from ".length));
      file.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = unquotePath(line.slice("rename to ".length));
      file.status = "renamed";
      continue;
    }
    if (line.startsWith("copy from ")) {
      file.oldPath = unquotePath(line.slice("copy from ".length));
      file.status = "copied";
      continue;
    }
    if (line.startsWith("copy to ")) {
      file.path = unquotePath(line.slice("copy to ".length));
      file.status = "copied";
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") ||
        line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity index")) {
      continue;
    }

    const m = HUNK_HEADER.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5].trim(),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    let entry: DiffLine | null = null;
    if (marker === "+") {
      entry = { kind: "add", oldNumber: null, newNumber: newNo++, text };
      file.additions++;
    } else if (marker === "-") {
      entry = { kind: "del", oldNumber: oldNo++, newNumber: null, text };
      file.deletions++;
    } else if (marker === " ") {
      entry = { kind: "context", oldNumber: oldNo++, newNumber: newNo++, text };
    }
    if (entry) hunk.lines.push(entry);
  }

  closeFile();
  return files;
}
