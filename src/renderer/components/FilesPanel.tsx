import type { FileNode } from '../../shared/files-types';
import { useFilesStore } from '../state/files-store';
import { useWorkspaceStore } from '../state/workspace-store';

/**
 * FILES tab — a workspace file explorer with a lazy tree and an inline text
 * editor with save (view/edit workspace files). All reads
 * and writes are sandboxed to the workspace root in main.
 */

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const expanded = useFilesStore((s) => s.expanded.has(node.relPath));
  const children = useFilesStore((s) => s.children[node.relPath]);
  const openPath = useFilesStore((s) => s.openFile?.relPath);
  const toggleDir = useFilesStore((s) => s.toggleDir);
  const selectFile = useFilesStore((s) => s.selectFile);

  const isDir = node.kind === 'dir';
  const active = openPath === node.relPath;

  return (
    <>
      <button
        className={`files-node ${active ? 'files-node--active' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (isDir ? void toggleDir(node.relPath) : void selectFile(node.relPath))}
      >
        <span className="files-node__glyph">
          {isDir ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span className="files-node__name">{node.name}</span>
      </button>
      {isDir && expanded && children && (
        <>
          {children.length === 0 && (
            <span
              className="files-node__empty"
              style={{ paddingLeft: 18 + depth * 12 }}
            >
              vazio
            </span>
          )}
          {children.map((child) => (
            <TreeNode key={child.relPath} node={child} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

function Editor() {
  const file = useFilesStore((s) => s.openFile);
  const edit = useFilesStore((s) => s.edit);
  const save = useFilesStore((s) => s.save);
  const saving = useFilesStore((s) => s.saving);

  if (!file) {
    return (
      <div className="files-editor files-editor--empty">
        Selecione um arquivo à esquerda para ver ou editar.
      </div>
    );
  }

  return (
    <div className="files-editor">
      <div className="files-editor__bar">
        <span className="files-editor__path" title={file.relPath}>
          {file.relPath}
          {file.dirty ? ' •' : ''}
        </span>
        <button
          className="files-editor__save"
          onClick={() => void save()}
          disabled={!file.dirty || saving || file.tooLarge || file.binary}
        >
          {saving ? 'Salvando…' : 'Salvar (⌘S)'}
        </button>
      </div>
      {file.error && <p className="files-editor__error">{file.error}</p>}
      {file.tooLarge ? (
        <div className="files-editor__notice">
          Arquivo grande demais para edição inline.
        </div>
      ) : file.binary ? (
        <div className="files-editor__notice">
          Arquivo binário — não é editável como texto.
        </div>
      ) : (
        <textarea
          className="files-editor__area"
          value={file.content}
          spellCheck={false}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              void save();
            }
          }}
        />
      )}
    </div>
  );
}

export function FilesPanel() {
  const open = useFilesStore((s) => s.open);
  const closePanel = useFilesStore((s) => s.closePanel);
  const root = useFilesStore((s) => s.children['']);
  const workspace = useWorkspaceStore((s) => s.current);

  if (!open) return null;

  return (
    <aside className="files" aria-label="Arquivos do workspace">
      <header className="files__header">
        <span className="files__title">
          FILES{workspace ? ` · ${workspace.name}` : ''}
        </span>
        <button className="files__close" onClick={closePanel} aria-label="Fechar">
          ✕
        </button>
      </header>
      <div className="files__body">
        <nav className="files__tree">
          {!root ? (
            <span className="files-node__empty">Carregando…</span>
          ) : (
            root.map((node) => (
              <TreeNode key={node.relPath} node={node} depth={0} />
            ))
          )}
        </nav>
        <Editor />
      </div>
    </aside>
  );
}
