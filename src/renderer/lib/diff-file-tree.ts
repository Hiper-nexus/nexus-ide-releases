// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: apps/web/src/components/diffs/
// diffFileTree.logic.ts (directory ids, diff-order positions and comparator) plus the
// expansion rules of components/files/fileTreeExpansion.ts, recast as pure row building for
// a React tree (no @pierre/trees model): collapsed folders are a Set of directory ids, empty
// folder chains are flattened like Pierre's `flattenEmptyDirectories`, and keyboard moves
// follow the WAI-ARIA tree pattern.

export interface DiffFileTreeRow {
  readonly kind: 'directory' | 'file';
  /** Arquivos usam o caminho; pastas, o id com `/` final que o Pierre usa. */
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  /** Id da pasta visível que contém a linha (null na raiz). */
  readonly parentPath: string | null;
  readonly expanded?: boolean;
}

/**
 * Every directory on the way to each file, registered with the trailing slash Pierre uses for
 * directory ids. Parents come before children so the tree can add them in order.
 */
export function collectDirectoryPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    let directory = '';
    for (const segment of segments.slice(0, -1)) {
      directory += `${segment}/`;
      directories.add(directory);
    }
  }
  return [...directories];
}

/** A folder takes the position of its first file in the diff. */
export function diffFileTreePositions(paths: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  paths.forEach((path, index) => {
    positions.set(path, index);
    let directory = '';
    for (const segment of path.split('/').slice(0, -1)) {
      directory += `${segment}/`;
      if (!positions.has(directory)) positions.set(directory, index);
    }
  });
  return positions;
}

/** Pastas que precisam abrir para a linha de `path` aparecer. */
export function ancestorDirectories(path: string): string[] {
  const ancestors: string[] = [];
  let directory = '';
  for (const segment of path.split('/').slice(0, -1)) {
    directory += `${segment}/`;
    ancestors.push(directory);
  }
  return ancestors;
}

interface DirectoryNode {
  readonly path: string;
  readonly name: string;
  readonly directories: Map<string, DirectoryNode>;
  readonly files: string[];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The visible rows of the tree, in the diff's own order: a folder sits where its first file
 * does, so the tree reads in the same order as the status list it replaces.
 */
export function buildDiffFileTreeRows(
  paths: ReadonlyArray<string>,
  collapsed: ReadonlySet<string>,
): DiffFileTreeRow[] {
  const positions = diffFileTreePositions(paths);
  const root: DirectoryNode = { path: '', name: '', directories: new Map(), files: [] };
  for (const path of paths) {
    let node = root;
    for (const directory of ancestorDirectories(path)) {
      let child = node.directories.get(directory);
      if (!child) {
        child = {
          path: directory,
          name: basename(directory.slice(0, -1)),
          directories: new Map(),
          files: [],
        };
        node.directories.set(directory, child);
      }
      node = child;
    }
    node.files.push(path);
  }

  const position = (path: string) => positions.get(path) ?? Number.MAX_SAFE_INTEGER;
  const rows: DiffFileTreeRow[] = [];
  const visit = (node: DirectoryNode, depth: number, parentPath: string | null) => {
    const children = [
      ...[...node.directories.values()].map((directory) => ({ path: directory.path, directory })),
      ...node.files.map((path) => ({ path, directory: null })),
    ].sort(
      (left, right) => position(left.path) - position(right.path) || left.path.localeCompare(right.path),
    );
    for (const child of children) {
      if (child.directory === null) {
        rows.push({ kind: 'file', path: child.path, name: basename(child.path), depth, parentPath });
        continue;
      }
      // A folder whose only entry is another folder shares its row ("src/renderer").
      let directory = child.directory;
      let name = directory.name;
      while (directory.files.length === 0 && directory.directories.size === 1) {
        const [only] = directory.directories.values();
        if (!only) break;
        name = `${name}/${only.name}`;
        directory = only;
      }
      const expanded = !collapsed.has(directory.path);
      rows.push({ kind: 'directory', path: directory.path, name, depth, parentPath, expanded });
      if (expanded) visit(directory, depth + 1, directory.path);
    }
  };
  visit(root, 0, null);
  return rows;
}

/**
 * The folders the reader closed that still exist after a refresh. A diff that changes under
 * the reader (an agent edit, the 8s poll) keeps their choice instead of reopening everything.
 */
export function retainCollapsedDirectories(
  collapsed: ReadonlySet<string>,
  paths: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (collapsed.size === 0) return collapsed;
  const directories = new Set(collectDirectoryPaths(paths));
  const retained = [...collapsed].filter((path) => directories.has(path));
  return retained.length === collapsed.size ? collapsed : new Set(retained);
}

export type DiffFileTreeMove =
  | { readonly type: 'focus'; readonly path: string }
  | { readonly type: 'toggle'; readonly path: string };

/** WAI-ARIA tree keys over the visible rows. */
export function diffFileTreeKeyMove(
  rows: ReadonlyArray<DiffFileTreeRow>,
  currentPath: string,
  key: string,
): DiffFileTreeMove | null {
  const index = rows.findIndex((row) => row.path === currentPath);
  const row = rows[index];
  if (!row) return null;
  const focus = (target: DiffFileTreeRow | undefined): DiffFileTreeMove | null =>
    target ? { type: 'focus', path: target.path } : null;
  switch (key) {
    case 'ArrowDown':
      return focus(rows[index + 1]);
    case 'ArrowUp':
      return focus(rows[index - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows.at(-1));
    case 'ArrowRight':
      if (row.kind !== 'directory') return null;
      if (!row.expanded) return { type: 'toggle', path: row.path };
      return rows[index + 1]?.parentPath === row.path ? focus(rows[index + 1]) : null;
    case 'ArrowLeft':
      if (row.kind === 'directory' && row.expanded) return { type: 'toggle', path: row.path };
      return row.parentPath === null ? null : { type: 'focus', path: row.parentPath };
    default:
      return null;
  }
}
