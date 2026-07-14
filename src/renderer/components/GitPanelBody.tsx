/**
 * Source Control body for ContextualPanel → Git tab.
 * Inspired by Orca SourceControl: Changes / History, stage, commit, file diff.
 */
import { useEffect } from 'react';
import type { GitFileChange } from '../../shared/git-scm';
import { useGitScmStore, type SelectedGitFile } from '../state/git-scm-store';
import { useWorkspaceStore } from '../state/workspace-store';

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i === -1 ? path : path.slice(i + 1);
}

function FileRow({
  file,
  section,
  actionLabel,
  onAction,
  onSelect,
  selected,
  disabled,
}: {
  file: GitFileChange;
  section: SelectedGitFile['section'];
  actionLabel: string;
  onAction: () => void;
  onSelect: () => void;
  selected: boolean;
  disabled: boolean;
}) {
  return (
    <li className={`git-scm__file${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="git-scm__file-main"
        onClick={onSelect}
        title={
          file.originalPath
            ? `${file.originalPath} → ${file.path}`
            : file.path
        }
      >
        <span className="git-scm__code" data-status={file.status}>
          {file.status}
        </span>
        <span className="git-scm__name">{basename(file.path)}</span>
        <span className="git-scm__path">
          {file.originalPath
            ? `${file.originalPath} → ${file.path}`
            : file.path}
        </span>
      </button>
      <button
        type="button"
        className="git-scm__file-action"
        onClick={onAction}
        disabled={disabled}
        title={actionLabel}
        aria-label={`${actionLabel} ${file.path}`}
      >
        {section === 'staged' ? '−' : '+'}
      </button>
    </li>
  );
}

function Section({
  title,
  files,
  section,
  actionLabel,
  onAction,
  onActionAll,
  allLabel,
  disabled,
}: {
  title: string;
  files: GitFileChange[];
  section: SelectedGitFile['section'];
  actionLabel: string;
  onAction: (path: string) => void;
  onActionAll?: () => void;
  allLabel?: string;
  disabled: boolean;
}) {
  const selected = useGitScmStore((s) => s.selected);
  const selectFile = useGitScmStore((s) => s.selectFile);
  if (files.length === 0) return null;

  return (
    <section className="git-scm__section" aria-label={title}>
      <header className="git-scm__section-head">
        <h4>
          {title}
          <span className="git-scm__count">{files.length}</span>
        </h4>
        {onActionAll && allLabel && (
          <button
            type="button"
            className="git-scm__link"
            onClick={onActionAll}
            disabled={disabled}
          >
            {allLabel}
          </button>
        )}
      </header>
      <ul className="git-scm__files">
        {files.map((file) => (
          <FileRow
            key={`${section}:${file.path}`}
            file={file}
            section={section}
            actionLabel={actionLabel}
            selected={
              selected?.path === file.path && selected.section === section
            }
            disabled={disabled}
            onSelect={() => void selectFile({ path: file.path, section })}
            onAction={() => onAction(file.path)}
          />
        ))}
      </ul>
    </section>
  );
}

export function GitPanelBody() {
  const workspacePath = useWorkspaceStore((s) => s.current?.path);
  const tab = useGitScmStore((s) => s.tab);
  const branch = useGitScmStore((s) => s.branch);
  const clean = useGitScmStore((s) => s.clean);
  const truncated = useGitScmStore((s) => s.truncated);
  const staged = useGitScmStore((s) => s.staged);
  const unstaged = useGitScmStore((s) => s.unstaged);
  const untracked = useGitScmStore((s) => s.untracked);
  const commits = useGitScmStore((s) => s.commits);
  const commitMessage = useGitScmStore((s) => s.commitMessage);
  const diffText = useGitScmStore((s) => s.diffText);
  const selected = useGitScmStore((s) => s.selected);
  const loading = useGitScmStore((s) => s.loading);
  const mutating = useGitScmStore((s) => s.mutating);
  const committing = useGitScmStore((s) => s.committing);
  const error = useGitScmStore((s) => s.error);
  const setTab = useGitScmStore((s) => s.setTab);
  const setCommitMessage = useGitScmStore((s) => s.setCommitMessage);
  const refresh = useGitScmStore((s) => s.refresh);
  const stage = useGitScmStore((s) => s.stage);
  const unstage = useGitScmStore((s) => s.unstage);
  const stageAll = useGitScmStore((s) => s.stageAll);
  const unstageAll = useGitScmStore((s) => s.unstageAll);
  const commit = useGitScmStore((s) => s.commit);
  const reset = useGitScmStore((s) => s.reset);

  useEffect(() => {
    reset();
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const id = window.setInterval(() => void refresh(), 8_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(id);
    };
  }, [workspacePath, refresh, reset]);

  const workspaceLabel = workspacePath
    ? workspacePath.split(/[/\\]/).filter(Boolean).slice(-2).join('/')
    : 'sem workspace';
  const busy = loading || mutating || committing;

  return (
    <div className="git-scm product-pane" data-testid="git-scm-panel">
      <header className="git-scm__toolbar">
        <div className="git-scm__repo" title={workspacePath ?? undefined}>
          <span className="git-scm__repo-path">{workspaceLabel}</span>
          <span className="git-scm__branch">{branch ?? '—'}</span>
        </div>
        <button
          type="button"
          className="product-pane__btn"
          onClick={() => void refresh()}
          disabled={busy}
          title="Atualizar"
          aria-label="Atualizar status git"
        >
          ↻
        </button>
      </header>

      <div className="git-scm__tabs" role="tablist" aria-label="Git">
        <button
          type="button"
          role="tab"
          id="git-scm-tab-changes"
          aria-controls="git-scm-panel-changes"
          aria-selected={tab === 'changes'}
          tabIndex={tab === 'changes' ? 0 : -1}
          className={tab === 'changes' ? 'is-active' : ''}
          onClick={() => setTab('changes')}
        >
          Alterações
        </button>
        <button
          type="button"
          role="tab"
          id="git-scm-tab-history"
          aria-controls="git-scm-panel-history"
          aria-selected={tab === 'history'}
          tabIndex={tab === 'history' ? 0 : -1}
          className={tab === 'history' ? 'is-active' : ''}
          onClick={() => setTab('history')}
        >
          Histórico
        </button>
      </div>

      {error && (
        <p className="product-pane__error" role="alert">
          {error}
        </p>
      )}
      {truncated && (
        <p className="product-pane__meta">
          Lista truncada — há muitas mudanças no working tree.
        </p>
      )}
      {loading && !error && (
        <p className="product-pane__meta">Lendo git status…</p>
      )}

      {tab === 'changes' ? (
        <div
          id="git-scm-panel-changes"
          role="tabpanel"
          aria-labelledby="git-scm-tab-changes"
          className="git-scm__tabpanel"
        >
          {clean && !loading ? (
            <div className="git-scm__empty" data-testid="git-scm-clean">
              <div className="git-scm__check" aria-hidden>
                ✓
              </div>
              <h3>Nothing to commit</h3>
              <p>Your working tree is clean.</p>
            </div>
          ) : (
            <div className="git-scm__lists">
              <Section
                title="Staged"
                files={staged}
                section="staged"
                actionLabel="Unstage"
                allLabel="Unstage All"
                disabled={busy}
                onAction={(path) => void unstage([path])}
                onActionAll={() => void unstageAll()}
              />
              <Section
                title="Changes"
                files={unstaged}
                section="unstaged"
                actionLabel="Stage"
                allLabel="Stage All"
                disabled={busy}
                onAction={(path) => void stage([path])}
                onActionAll={() => void stageAll('unstaged')}
              />
              <Section
                title="Untracked"
                files={untracked}
                section="untracked"
                actionLabel="Stage"
                allLabel="Stage All"
                disabled={busy}
                onAction={(path) => void stage([path])}
                onActionAll={() => void stageAll('untracked')}
              />
            </div>
          )}

          <div className="git-scm__diff">
            <header className="git-scm__diff-head">
              <h4>Diff</h4>
              {selected && (
                <code className="git-scm__diff-path">{selected.path}</code>
              )}
            </header>
            {selected ? (
              <pre className="git-scm__diff-body">{diffText}</pre>
            ) : (
              <p className="git-scm__diff-placeholder">
                Select a file to view changes
              </p>
            )}
          </div>

          <footer className="git-scm__commit">
            <textarea
              className="product-pane__textarea git-scm__message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder={
                staged.length > 0
                  ? 'Commit message'
                  : 'Stage changes to commit'
              }
              rows={3}
              aria-label="Mensagem de commit"
              disabled={committing}
            />
            <button
              type="button"
              className="product-pane__btn git-scm__commit-btn"
              disabled={
                committing || mutating || staged.length === 0 || !commitMessage.trim()
              }
              onClick={() => void commit()}
            >
              {committing ? 'Committing…' : 'Commit'}
            </button>
          </footer>
        </div>
      ) : (
        <ul
          id="git-scm-panel-history"
          role="tabpanel"
          aria-labelledby="git-scm-tab-history"
          className="git-scm__history product-pane__list"
        >
          {commits.length === 0 && !loading && (
            <li className="product-pane__meta">Nenhum commit encontrado.</li>
          )}
          {commits.map((c) => (
            <li key={c.hash} className="git-scm__commit-row product-pane__item">
              <code className="git-scm__hash">{c.hash}</code>
              <span>{c.subject}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
