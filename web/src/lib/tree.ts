import type { DiffFile } from "../../../src/types.ts";

export interface Node {
  name: string;
  path: string;
  children: Node[];
  file?: DiffFile;
}

function insert(root: Node, file: DiffFile): void {
  const parts = file.path.split("/");
  let node = root;
  parts.forEach((part, i) => {
    const path = parts.slice(0, i + 1).join("/");
    let child = node.children.find((c) => c.path === path);
    if (!child) {
      child = { name: part, path, children: [] };
      node.children.push(child);
    }
    if (i === parts.length - 1) child.file = file;
    node = child;
  });
}

/** Fold single-child directory chains into one row, the way GitHub does. */
function compress(node: Node): Node {
  const children = node.children.map(compress);
  if (children.length === 1 && !node.file && !children[0].file && node.name) {
    const only = children[0];
    return { name: `${node.name}/${only.name}`, path: only.path, children: only.children };
  }
  return { ...node, children };
}

/** Folders before files, then by name, at every level. */
function sortTree(node: Node): void {
  node.children.sort((a, b) => {
    const aFile = a.file ? 1 : 0;
    const bFile = b.file ? 1 : 0;
    if (aFile !== bFile) return aFile - bFile;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

export function buildTree(files: DiffFile[]): Node {
  const root: Node = { name: "", path: "", children: [] };
  files.forEach((f) => insert(root, f));
  const compressed = compress(root);
  sortTree(compressed);
  return compressed;
}

/** The files in the order the sidebar tree shows them, top to bottom. */
export function inTreeOrder(files: DiffFile[]): DiffFile[] {
  const out: DiffFile[] = [];
  const walk = (node: Node) =>
    node.children.forEach((child) => {
      if (child.file) out.push(child.file);
      else walk(child);
    });
  walk(buildTree(files));
  return out;
}
