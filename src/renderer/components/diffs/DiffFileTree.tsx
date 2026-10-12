// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: rendered with Nexus rows (PixelIcon,
// git-scm.css) instead of @pierre/trees, so each file keeps its stage/unstage/discard actions;
// keeps upstream's reveal rules (expand ancestors, scroll nearest once per selection, no echo
// for the reader's own click) and the reader's closed folders across refreshes.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { GitFileChange } from '../../../shared/git-scm';
import {
  ancestorDirectories,
  buildDiffFileTreeRows,
  diffFileTreeKeyMove,
  retainCollapsedDirectories,
  type DiffFileTreeRow,
} from '../../lib/diff-file-tree';
import { PixelIcon } from '../PixelIcon';

interface DiffFileTreeProps {
  readonly files: ReadonlyArray<GitFileChange>;
  /** O arquivo que o diff mostra; a árvore abre as pastas dele e rola até ele uma vez. */
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
  readonly renderFileActions: (file: GitFileChange) => ReactNode;
  readonly ariaLabel: string;
}

const INDENT_PX = 12;

/**
 * Os arquivos alterados de uma seção do Git como árvore de pastas. Toda pasta começa aberta:
 * um diff é uma lista curta perto de um workspace, e o leitor veio pelos arquivos.
 */
export function DiffFileTree({
  files,
  selectedPath,
  onSelectFile,
  renderFileActions,
  ariaLabel,
}: DiffFileTreeProps) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const [collapsedState, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const collapsed = useMemo(
    () => retainCollapsedDirectories(collapsedState, paths),
    [collapsedState, paths],
  );
  const rows = useMemo(() => buildDiffFileTreeRows(paths, collapsed), [collapsed, paths]);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focusRequestRef = useRef<string | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  // Selection driven by `selectedPath` is an echo of a file already on screen when the reader
  // picked it here, not a request to scroll to it again.
  const handledRevealRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedPath === null || !filesByPath.has(selectedPath)) {
      // A file that left the list has to be revealed again when it comes back.
      handledRevealRef.current = null;
      return;
    }
    // A refresh that rebuilds the list under an already-revealed file must not pull the tree
    // back to it, nor reopen a folder the reader closed since.
    if (handledRevealRef.current === selectedPath) return;
    handledRevealRef.current = selectedPath;
    const ancestors = ancestorDirectories(selectedPath);
    pendingScrollRef.current = selectedPath;
    setFocusPath(selectedPath);
    setCollapsed((previous) =>
      ancestors.some((path) => previous.has(path))
        ? new Set([...previous].filter((path) => !ancestors.includes(path)))
        : previous,
    );
  }, [filesByPath, selectedPath]);

  useEffect(() => {
    const scrollPath = pendingScrollRef.current;
    const scrollRow = scrollPath ? rowRefs.current.get(scrollPath) : undefined;
    if (scrollRow) {
      pendingScrollRef.current = null;
      scrollRow.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    const focusTarget = focusRequestRef.current;
    const focusRow = focusTarget ? rowRefs.current.get(focusTarget) : undefined;
    if (focusRow) {
      focusRequestRef.current = null;
      focusRow.focus();
    }
  });

  const activePath =
    rows.find((row) => row.path === focusPath)?.path ??
    rows.find((row) => row.path === selectedPath)?.path ??
    rows[0]?.path ??
    null;

  const toggleDirectory = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(retainCollapsedDirectories(previous, paths));
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFile = (path: string) => {
    handledRevealRef.current = path;
    setFocusPath(path);
    onSelectFile(path);
  };

  const activate = (row: DiffFileTreeRow) => {
    if (row.kind === 'file') {
      selectFile(row.path);
      return;
    }
    setFocusPath(row.path);
    toggleDirectory(row.path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: DiffFileTreeRow) => {
    // Keys typed on a row's own action buttons belong to those buttons.
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(row);
      return;
    }
    const move = diffFileTreeKeyMove(rows, row.path, event.key);
    if (!move) return;
    event.preventDefault();
    if (move.type === 'toggle') {
      toggleDirectory(move.path);
      return;
    }
    focusRequestRef.current = move.path;
    setFocusPath(move.path);
  };

  const bindRow = (path: string) => (node: HTMLLIElement | null) => {
    if (node) rowRefs.current.set(path, node);
    else rowRefs.current.delete(path);
  };

  // Each <li> is the treeitem itself (the tree's only children are treeitems). A file's
  // stage/unstage/discard buttons live inside its treeitem; their clicks stop there so they
  // never select the row.
  return (
    <ul className="git-scm__files git-scm__tree" role="tree" aria-label={ariaLabel}>
      {rows.map((row) => {
        const indent = { paddingLeft: 6 + row.depth * INDENT_PX };
        const rowProps = {
          ref: bindRow(row.path),
          role: 'treeitem',
          'aria-level': row.depth + 1,
          tabIndex: row.path === activePath ? 0 : -1,
          onClick: () => activate(row),
          onKeyDown: (event: KeyboardEvent<HTMLLIElement>) => handleKeyDown(event, row),
        } as const;
        if (row.kind === 'directory') {
          return (
            <li
              key={row.path}
              {...rowProps}
              aria-expanded={row.expanded}
              className="git-scm__tree-dir"
              title={row.path.slice(0, -1)}
            >
              <span className="git-scm__file-main git-scm__tree-dir-main" style={indent}>
                <PixelIcon name={row.expanded ? 'chevron-down' : 'chevron'} size={10} />
                <span className="git-scm__name">{row.name}</span>
              </span>
            </li>
          );
        }
        const file = filesByPath.get(row.path);
        if (!file) return null;
        const selected = row.path === selectedPath;
        return (
          <li
            key={row.path}
            {...rowProps}
            aria-selected={selected}
            // Without a label the name would also read the action buttons' labels.
            aria-label={`${row.name}, ${file.status}`}
            className={`git-scm__file${selected ? ' is-selected' : ''}`}
            // F-1413: o caminho completo vai no tooltip CSS (data-tip) — o `title`
            // nativo vaza para fora do painel estreito e é cortado na borda.
            data-tip={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
          >
            <span className="git-scm__file-main" style={indent}>
              <span className="git-scm__code" data-status={file.status}>
                {file.status}
              </span>
              <span className="git-scm__name">{row.name}</span>
            </span>
            <span className="git-scm__tree-actions" onClick={(event) => event.stopPropagation()}>
              {renderFileActions(file)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
