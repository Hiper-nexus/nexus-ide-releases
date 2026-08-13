/**
 * Source Control body for ContextualPanel → Git tab.
 * Inspired by Orca SourceControl: Changes / History, stage, commit, file diff.
 * Primary action button adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
 * (source-control-primary-action-decision). See third_party/licenses/orca-MIT.txt.
 */
import { useEffect, useMemo, useState } from 'react';
import type { GitFileChange } from '../../shared/git-scm';
import type { ExternalIssue } from '../../shared/integrations-types';
import { presentGitHubPRMergeState } from '../../shared/github-pr-merge-state';
import {
  diffLineCommentTarget,
  parseDiffViewLines,
  type GitDiffViewLine,
} from '../../shared/git-diff-view';
import { sendAnnotationsToAgent } from '../lib/agent-attach';
import { startMissionFromIssue } from '../lib/start-mission-from-issue';
import {
  decideGitPrimaryAction,
  gitPrimaryActionBusyLabel,
} from '../state/git-primary-action';
import { useGitScmStore, type SelectedGitFile } from '../state/git-scm-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { CoffeeCup } from '../pet/CoffeeCup';

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

function GitDiffAnnotator({
  diffText,
  path,
}: {
  diffText: string;
  path: string;
}) {
  const rows = useMemo(() => parseDiffViewLines(diffText), [diffText]);
  const [selected, setSelected] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const target =
    selected === null ? null : diffLineCommentTarget(rows[selected] ?? { kind: 'meta', text: '' });

  async function send() {
    if (!target || !note.trim()) return;
    setSending(true);
    setStatus(null);
    try {
      const ok = await sendAnnotationsToAgent([
        {
          path,
          line: target.line,
          body: `${note.trim()}\n\n> ${target.snippet}`.trim(),
        },
      ]);
      setStatus(ok ? 'Comentário enviado ao agente.' : 'Não achei um agente para receber o comentário.');
      if (ok) {
        setNote('');
        setSelected(null);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'falha ao enviar comentário');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="git-scm__diff-annotator">
      <div className="git-scm__diff-body git-scm__diff-lines" role="list">
        {rows.map((row, index) => (
          <DiffLine
            key={`${index}:${row.kind}:${row.text.slice(0, 24)}`}
            row={row}
            selected={selected === index}
            onSelect={() => {
              if (!diffLineCommentTarget(row)) return;
              setSelected(index);
              setStatus(null);
            }}
          />
        ))}
      </div>
      {target && (
        <form
          className="git-scm__diff-comment"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="git-scm__diff-comment-label" htmlFor="git-diff-comment">
            Comentar linha {target.line}
          </label>
          <input
            id="git-diff-comment"
            className="product-pane__input git-scm__diff-comment-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Comentar esta linha"
            disabled={sending}
          />
          <button
            type="submit"
            className="product-pane__btn"
            disabled={sending || !note.trim()}
          >
            {sending ? 'Enviando…' : 'Enviar ao agente'}
          </button>
        </form>
      )}
      {status && (
        <p className="product-pane__meta" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

function DiffLine({
  row,
  selected,
  onSelect,
}: {
  row: GitDiffViewLine;
  selected: boolean;
  onSelect: () => void;
}) {
  const target = diffLineCommentTarget(row);
  const lineNo = target?.line;
  const className = [
    'git-scm__diff-line',
    `git-scm__diff-line--${row.kind}`,
    selected ? 'is-selected' : '',
    target ? 'is-clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (!target) {
    return (
      <div className={className} role="listitem">
        <span className="git-scm__diff-gutter" />
        <span className="git-scm__diff-text">{row.text || ' '}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      role="listitem"
      onClick={onSelect}
      title={`Comentar linha ${lineNo}`}
    >
      <span className="git-scm__diff-gutter">{lineNo}</span>
      <span className="git-scm__diff-text">{row.text || ' '}</span>
    </button>
  );
}

function IssueCard({ issue }: { issue: ExternalIssue }) {
  return (
    <li className="git-scm__issue">
      <a
        className="git-scm__issue-link"
        href={issue.url}
        target="_blank"
        rel="noreferrer"
      >
        <span className="git-scm__issue-id">
          {issue.provider === 'github' && issue.number
            ? `#${issue.number}`
            : issue.provider}
        </span>
        <span className="git-scm__issue-title">{issue.title}</span>
      </a>
      <button
        type="button"
        className="product-pane__btn git-scm__issue-action"
        onClick={() => startMissionFromIssue(issue)}
      >
        Começar missão
      </button>
    </li>
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
  const remoteBusy = useGitScmStore((s) => s.remoteBusy);
  const error = useGitScmStore((s) => s.error);
  const setTab = useGitScmStore((s) => s.setTab);
  const setCommitMessage = useGitScmStore((s) => s.setCommitMessage);
  const refresh = useGitScmStore((s) => s.refresh);
  const stage = useGitScmStore((s) => s.stage);
  const unstage = useGitScmStore((s) => s.unstage);
  const stageAll = useGitScmStore((s) => s.stageAll);
  const unstageAll = useGitScmStore((s) => s.unstageAll);
  const runPrimaryAction = useGitScmStore((s) => s.runPrimaryAction);
  const pr = useGitScmStore((s) => s.pr);
  const prBusy = useGitScmStore((s) => s.prBusy);
  const prError = useGitScmStore((s) => s.prError);
  const enqueuePr = useGitScmStore((s) => s.enqueuePr);
  const setAutoMerge = useGitScmStore((s) => s.setAutoMerge);
  const issues = useGitScmStore((s) => s.issues);
  const issuesError = useGitScmStore((s) => s.issuesError);
  const issuesLoading = useGitScmStore((s) => s.issuesLoading);
  const reset = useGitScmStore((s) => s.reset);
  const ahead = useGitScmStore((s) => s.ahead);
  const behind = useGitScmStore((s) => s.behind);
  const hasUpstream = useGitScmStore((s) => s.hasUpstream);
  const hasUnresolvedConflicts = useGitScmStore((s) => s.hasUnresolvedConflicts);
  const defaultBranch = useGitScmStore((s) => s.defaultBranch);
  const prView = pr ? presentGitHubPRMergeState(pr) : null;

  const decision = decideGitPrimaryAction({
    stagedCount: staged.length,
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    commitMessage,
    hasUnresolvedConflicts,
    committing,
    remoteBusy,
    branch,
    hasUpstream,
    ahead,
    behind,
    defaultBranch,
    pr,
  });
  const busyLabel = gitPrimaryActionBusyLabel(decision, {
    committing,
    remoteBusy,
    prBusy,
  });

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
  const busy = loading || mutating || committing || remoteBusy;

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
        <button
          type="button"
          role="tab"
          id="git-scm-tab-issues"
          aria-controls="git-scm-panel-issues"
          aria-selected={tab === 'issues'}
          tabIndex={tab === 'issues' ? 0 : -1}
          className={tab === 'issues' ? 'is-active' : ''}
          onClick={() => setTab('issues')}
        >
          Issues
        </button>
      </div>

      {pr && prView && (
        <section className="git-scm__pr" aria-label="Pull request">
          <div className="git-scm__pr-main">
            <a
              className="git-scm__pr-link"
              href={pr.url}
              target="_blank"
              rel="noreferrer"
            >
              #{pr.number} {pr.title}
            </a>
            <span
              className={`git-scm__pr-tone git-scm__pr-tone--${prView.tone}`}
              title={prView.tooltip}
            >
              {prView.label}
            </span>
          </div>
          {prView.autoMergeAction && (
            <button
              type="button"
              className="product-pane__btn git-scm__pr-action"
              disabled={busy || prBusy}
              title={prView.autoMergeAction.tooltip}
              onClick={() => {
                if (prView.autoMergeAction?.kind === 'disable') {
                  void setAutoMerge(false);
                  return;
                }
                void enqueuePr('when-ready');
              }}
            >
              {prBusy ? '…' : prView.autoMergeAction.label}
            </button>
          )}
        </section>
      )}
      {prError && !error && (
        <p className="product-pane__meta" role="status">
          {prError}
        </p>
      )}
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
              <div className="git-scm__empty-coffee" aria-hidden>
                <CoffeeCup size={56} celebrating={!decision.disabled} />
              </div>
              <h3>Mesa limpa</h3>
              <p>
                {decision.disabled
                  ? 'Nada para commitar.'
                  : decision.title}
              </p>
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
              <GitDiffAnnotator diffText={diffText} path={selected.path} />
            ) : (
              <p className="git-scm__diff-placeholder">
                Selecione um arquivo para ver as mudanças
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
                  ? 'Mensagem de commit'
                  : 'Adicione arquivos para commitar'
              }
              rows={3}
              aria-label="Mensagem de commit"
              disabled={committing}
            />
            <button
              type="button"
              className="product-pane__btn git-scm__commit-btn"
              disabled={busy || prBusy || decision.disabled}
              title={decision.title}
              onClick={() => void runPrimaryAction()}
            >
              {busyLabel ?? decision.label}
            </button>
          </footer>
        </div>
      ) : tab === 'history' ? (
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
      ) : (
        <div
          id="git-scm-panel-issues"
          role="tabpanel"
          aria-labelledby="git-scm-tab-issues"
          className="git-scm__tabpanel"
        >
          {issuesLoading && (
            <p className="product-pane__meta">Carregando issues…</p>
          )}
          {issuesError && (
            <p className="product-pane__error" role="alert">
              {issuesError}
            </p>
          )}
          {!issuesLoading && issues.length === 0 && !issuesError && (
            <p className="product-pane__meta">
              Nenhuma issue aberta no GitHub ou Linear.
            </p>
          )}
          <ul className="git-scm__issues product-pane__list">
            {issues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
