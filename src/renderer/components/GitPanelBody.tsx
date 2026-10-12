/**
 * Source Control body for ContextualPanel → Git tab.
 * Inspired by Orca SourceControl: Changes / History, stage, commit, file diff.
 * Primary action button adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
 * (source-control-primary-action-decision). See third_party/licenses/orca-MIT.txt.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { GitFileChange } from '../../shared/git-scm';
import type { ExternalIssue } from '../../shared/integrations-types';
import { presentGitHubPRMergeState } from '../../shared/github-pr-merge-state';
import {
  diffLineCommentTarget,
  parseDiffViewLines,
  type GitDiffViewLine,
} from '../../shared/git-diff-view';
import { sendAnnotationsToAgent } from '../lib/agent-attach';
import {
  buildFileDiffContentVersion,
  getRenderablePatch,
  resolveFileDiffPath,
} from '../lib/diff-rendering';
import { startMissionFromIssue } from '../lib/start-mission-from-issue';
import {
  decideGitPrimaryAction,
  gitPrimaryActionBusyLabel,
} from '../state/git-primary-action';
import { useGitScmStore, type SelectedGitFile } from '../state/git-scm-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { CoffeeCup } from '../pet/CoffeeCup';
import { gitErrorCopy } from '../lib/git-error-copy';
import { setVisibleInterval } from '../lib/visible-interval';
import { DiffFileTree } from './diffs/DiffFileTree';
import { PixelIcon } from './PixelIcon';
import type { DiffCommentAnchor, DiffCommentTarget } from './diffs/AnnotatableCodeView';

// Pierre + Shiki ficam num chunk à parte: só carregam quando um diff realçado aparece.
const AnnotatableCodeView = lazy(() =>
  import('./diffs/AnnotatableCodeView').then((module) => ({
    default: module.AnnotatableCodeView,
  })),
);

function FileActions({
  file,
  section,
  actionLabel,
  onAction,
  onDiscard,
  disabled,
}: {
  file: GitFileChange;
  section: SelectedGitFile['section'];
  actionLabel: string;
  onAction: () => void;
  onDiscard?: () => void;
  disabled: boolean;
}) {
  return (
    <span className="git-scm__file-actions">
      {onDiscard && (
        <button
          type="button"
          className="git-scm__file-action git-scm__file-discard"
          onClick={onDiscard}
          disabled={disabled}
          title="Descartar alterações neste arquivo"
          aria-label={`Descartar alterações em ${file.path}`}
        >
          ↺
        </button>
      )}
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
    </span>
  );
}

function Section({
  title,
  files,
  section,
  actionLabel,
  onAction,
  onActionAll,
  onDiscard,
  onDiscardAll,
  allLabel,
  disabled,
}: {
  title: string;
  files: GitFileChange[];
  section: SelectedGitFile['section'];
  actionLabel: string;
  onAction: (path: string) => void;
  onActionAll?: () => void;
  onDiscard?: (path: string) => void;
  onDiscardAll?: () => void;
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
        <div className="git-scm__section-actions">
          {onDiscardAll && (
            <button
              type="button"
              className="git-scm__link git-scm__link--danger"
              onClick={onDiscardAll}
              disabled={disabled}
              title="Descartar todas as alterações nesta seção"
            >
              Descartar tudo
            </button>
          )}
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
        </div>
      </header>
      <DiffFileTree
        files={files}
        ariaLabel={`Arquivos em ${title}`}
        selectedPath={selected?.section === section ? selected.path : null}
        onSelectFile={(path) => void selectFile({ path, section })}
        renderFileActions={(file) => (
          <FileActions
            file={file}
            section={section}
            actionLabel={actionLabel}
            disabled={disabled}
            onAction={() => onAction(file.path)}
            onDiscard={onDiscard ? () => onDiscard(file.path) : undefined}
          />
        )}
      />
    </section>
  );
}

type DiffStyle = 'unified' | 'split';

/** Onde um comentário mira: uma linha do diff em texto, ou um intervalo do viewer realçado. */
interface CommentTarget {
  id: string;
  /** Arquivo do comentário: o envio usa este, não o arquivo aberto agora. */
  path: string;
  line: number;
  snippet: string;
  rangeLabel?: string;
  anchor?: Omit<DiffCommentAnchor, 'id'>;
}

interface DraftComment extends CommentTarget {
  text: string;
}

/**
 * O viewer realçado (Pierre) mede linhas com ResizeObserver e Shadow DOM. Sem eles (jsdom,
 * ambientes mínimos) o diff continua em texto, com o mesmo fluxo de comentário.
 */
function supportsHighlightedDiff(): boolean {
  return typeof ResizeObserver === 'function';
}

function targetLabel(target: CommentTarget): string {
  if (!target.rangeLabel) return `linha ${target.line}`;
  return target.rangeLabel.includes(' a ')
    ? `linhas ${target.rangeLabel}`
    : `linha ${target.rangeLabel}`;
}

function quoteSnippet(snippet: string): string {
  return snippet
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Rascunhos são por arquivo e vivem no painel: trocar de arquivo (ou perder a seleção num
 * refresh) não os descarta; cada arquivo mostra só os seus, e o envio leva o caminho de cada um.
 */
function GitDiffAnnotator({
  diffText,
  path,
  diffStyle,
  drafts,
  setDrafts,
}: {
  diffText: string;
  path: string;
  diffStyle: DiffStyle;
  drafts: DraftComment[];
  setDrafts: Dispatch<SetStateAction<DraftComment[]>>;
}) {
  const highlight = supportsHighlightedDiff();
  const renderable = useMemo(
    () =>
      highlight
        ? getRenderablePatch(diffText, `git-panel:${path}`, { compactPartialHunkOffsets: true })
        : null,
    [diffText, highlight, path],
  );
  const codeViewFiles = useMemo(
    () =>
      renderable?.kind === 'files'
        ? renderable.files.map((fileDiff, index) => ({
            fileDiff,
            fileKey: `${index}:${resolveFileDiffPath(fileDiff)}`,
            fileVersion: buildFileDiffContentVersion(fileDiff),
          }))
        : [],
    [renderable],
  );
  const rows = useMemo(() => parseDiffViewLines(diffText), [diffText]);
  const [active, setActive] = useState<{ target: CommentTarget; row?: number } | null>(null);
  const [activeNote, setActiveNote] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Um editor aberto em outro arquivo não pertence a este diff.
  const activeTarget = active?.target.path === path ? active.target : null;
  const draftAnchor = useMemo<DiffCommentAnchor | null>(
    () =>
      activeTarget?.anchor ? { id: activeTarget.id, ...activeTarget.anchor } : null,
    [activeTarget],
  );
  const fileDrafts = useMemo(() => drafts.filter((draft) => draft.path === path), [drafts, path]);
  const commentAnchors = useMemo(
    () =>
      fileDrafts.flatMap((draft) => (draft.anchor ? [{ id: draft.id, ...draft.anchor }] : [])),
    [fileDrafts],
  );
  const draftFileCount = useMemo(() => new Set(drafts.map((draft) => draft.path)).size, [drafts]);

  function handleOpenEditor(index: number) {
    const target = diffLineCommentTarget(rows[index] ?? { kind: 'meta', text: '' });
    if (!target) return;
    setActive({ target: { id: `${path}:line:${target.line}`, path, ...target }, row: index });
    setStatus(null);
  }

  // Estável: o viewer reaplica as opções quando o callback muda de identidade.
  const beginComment = useCallback((target: DiffCommentTarget) => {
    setActive({
      target: {
        id: `${path}:${target.fileKey}:${target.anchor.side}:${target.line}-${target.anchor.lineNumber}`,
        path,
        line: target.line,
        snippet: target.snippet,
        rangeLabel: target.rangeLabel,
        anchor: { fileKey: target.fileKey, ...target.anchor },
      },
    });
    setStatus(null);
  }, [path]);

  function handleAddDraft() {
    if (!activeTarget || !activeNote.trim()) return;
    setDrafts((prev) => [
      ...prev.filter((d) => d.id !== activeTarget.id),
      { ...activeTarget, text: activeNote.trim() },
    ]);
    setActiveNote('');
    setActive(null);
  }

  function handleRemoveDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  async function handleSendAll(specificComments?: DraftComment[]) {
    const toSend = specificComments ?? (activeTarget && activeNote.trim()
      ? [...drafts, { ...activeTarget, text: activeNote.trim() }]
      : drafts);

    if (toSend.length === 0) return;
    setSending(true);
    setStatus(null);

    try {
      const annotations = toSend.map((item) => ({
        path: item.path,
        line: item.line,
        body: `${item.text}\n\n${quoteSnippet(item.snippet)}`.trim(),
      }));

      const ok = await sendAnnotationsToAgent(annotations);
      setStatus(
        ok
          ? `${annotations.length} comentário(s) enviado(s) ao agente.`
          : 'Não achei um agente ativo para receber as revisões.',
      );
      if (ok) {
        // Só sai o que foi enviado: "Enviar agora" não leva os rascunhos de outros arquivos.
        const sent = new Set(toSend.map((item) => item.id));
        setDrafts((prev) => prev.filter((d) => !sent.has(d.id)));
        setActiveNote('');
        setActive(null);
      }
    } catch (err) {
      setStatus(gitErrorCopy(err, 'comment').message);
    } finally {
      setSending(false);
    }
  }

  function renderEditor(target: CommentTarget) {
    return (
      <div className="git-scm__diff-inline-editor">
        <label className="git-scm__diff-comment-label">
          Anotação para {targetLabel(target)}:
        </label>
        <textarea
          rows={2}
          className="product-pane__input git-scm__diff-comment-input"
          value={activeNote}
          onChange={(e) => setActiveNote(e.target.value)}
          placeholder="Instrução para o agente ajustar esta linha..."
          disabled={sending}
          autoFocus
        />
        <div className="git-scm__diff-inline-actions">
          <button
            type="button"
            className="product-pane__btn product-pane__btn--ghost"
            onClick={() => {
              setActive(null);
              setActiveNote('');
            }}
            disabled={sending}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="product-pane__btn"
            onClick={handleAddDraft}
            disabled={sending || !activeNote.trim()}
          >
            Guardar rascunho
          </button>
          <button
            type="button"
            className="product-pane__btn product-pane__btn--primary"
            onClick={() => handleSendAll([{ ...target, text: activeNote.trim() }])}
            disabled={sending || !activeNote.trim()}
          >
            {sending ? 'Enviando…' : 'Enviar agora'}
          </button>
        </div>
      </div>
    );
  }

  function renderDraft(d: DraftComment) {
    const label = targetLabel(d);
    return (
      <div key={d.id} className="git-scm__diff-inline-comment">
        <span className="git-scm__diff-inline-comment-body">
          <strong>{label.charAt(0).toUpperCase() + label.slice(1)}:</strong> {d.text}
        </span>
        <button
          type="button"
          className="git-scm__diff-inline-comment-remove"
          title="Remover anotação"
          onClick={() => handleRemoveDraft(d.id)}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="git-scm__diff-annotator">
      {renderable?.kind === 'files' ? (
        <>
          {renderable.truncated && (
            <p className="git-scm__diff-notice" role="status">
              Diff truncado para proteger a UI — o fim do último trecho não aparece.
            </p>
          )}
          <Suspense
            fallback={
              <p className="git-scm__diff-placeholder" role="status">
                Carregando diff…
              </p>
            }
          >
            <AnnotatableCodeView
              files={codeViewFiles}
              comments={commentAnchors}
              draft={draftAnchor}
              options={{ diffStyle, overflow: 'scroll', stickyHeaders: true }}
              onBeginComment={beginComment}
              renderDraft={() => (activeTarget ? renderEditor(activeTarget) : null)}
              renderComment={(id) => {
                const draft = fileDrafts.find((d) => d.id === id);
                return draft ? renderDraft(draft) : null;
              }}
            />
          </Suspense>
        </>
      ) : (
        <>
          {renderable?.kind === 'raw' && renderable.reason && (
            <p className="git-scm__diff-notice" role="status">
              {renderable.reason}
            </p>
          )}
          <div className="git-scm__diff-body git-scm__diff-lines" role="list">
            {rows.map((row, index) => {
              const target = diffLineCommentTarget(row);
              const lineDrafts = target
                ? fileDrafts.filter((d) => !d.anchor && d.line === target.line)
                : [];
              const isEditorOpen = activeTarget !== null && active?.row === index;

              return (
                <div key={`${index}:${row.kind}:${row.text.slice(0, 24)}`} className="git-scm__diff-row">
                  <DiffLine
                    row={row}
                    selected={isEditorOpen}
                    onSelect={() => handleOpenEditor(index)}
                  />

                  {lineDrafts.map(renderDraft)}

                  {isEditorOpen && activeTarget && renderEditor(activeTarget)}
                </div>
              );
            })}
          </div>
        </>
      )}

      {drafts.length > 0 && (
        <div className="git-scm__diff-review-bar">
          <span className="git-scm__diff-review-counter">
            <PixelIcon name="file" size={12} />
            {drafts.length} {drafts.length === 1 ? 'revisão' : 'revisões'} em rascunho
            {draftFileCount > 1 ? ` em ${draftFileCount} arquivos` : ''}
          </span>
          <div className="git-scm__diff-inline-actions">
            <button
              type="button"
              className="product-pane__btn product-pane__btn--ghost"
              onClick={() => setDrafts([])}
              disabled={sending}
            >
              Descartar rascunhos
            </button>
            <button
              type="button"
              className="product-pane__btn product-pane__btn--primary"
              onClick={() => handleSendAll()}
              disabled={sending}
            >
              {sending ? 'Enviando…' : `Enviar todas ao agente (${drafts.length})`}
            </button>
          </div>
        </div>
      )}

      {status && (
        <p className="product-pane__meta" role="status" style={{ padding: '4px 8px', margin: 0 }}>
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
        <span />
        <span className="git-scm__diff-gutter" />
        <span className="git-scm__diff-text">{row.text || ' '}</span>
      </div>
    );
  }

  return (
    <div
      className={className}
      role="listitem"
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      title={`Comentar na linha ${lineNo}`}
    >
      <button
        type="button"
        className="git-scm__diff-gutter-action"
        title={`Adicionar comentário na linha ${lineNo}`}
        aria-label={`Adicionar comentário na linha ${lineNo}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        +
      </button>
      <span className="git-scm__diff-gutter">{lineNo}</span>
      <span className="git-scm__diff-text">{row.text || ' '}</span>
    </div>
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
  const pulling = useGitScmStore((s) => s.pulling);
  const branches = useGitScmStore((s) => s.branches);
  const branchesLoading = useGitScmStore((s) => s.branchesLoading);
  const loadBranches = useGitScmStore((s) => s.loadBranches);
  const checkout = useGitScmStore((s) => s.checkout);
  const pull = useGitScmStore((s) => s.pull);
  const pushCurrentBranch = useGitScmStore((s) => s.pushCurrentBranch);
  const discard = useGitScmStore((s) => s.discard);
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

  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [branchError, setBranchError] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified');
  const [diffDrafts, setDiffDrafts] = useState<DraftComment[]>([]);

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
    // Outro workspace: os caminhos dos rascunhos não valem mais.
    setDiffDrafts([]);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    // Cada refresh roda `git` no main: com a janela oculta o poll dorme.
    const stopPolling = setVisibleInterval(() => void refresh(), 8_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      stopPolling();
    };
  }, [workspacePath, refresh, reset]);

  const workspaceLabel = workspacePath
    ? workspacePath.split(/[/\\]/).filter(Boolean).slice(-2).join('/')
    : 'sem workspace';
  const busy = loading || mutating || committing || remoteBusy || pulling;

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setBranchError(null);
    const ok = await checkout(name, true);
    if (ok) {
      setNewBranchName('');
      setBranchMenuOpen(false);
    } else {
      setBranchError('Não foi possível criar a branch');
    }
  };

  const handleSwitchBranch = async (target: string) => {
    if (target === branch) {
      setBranchMenuOpen(false);
      return;
    }
    setBranchError(null);
    const ok = await checkout(target, false);
    if (ok) {
      setBranchMenuOpen(false);
    } else {
      setBranchError(`Não foi possível alternar para ${target}`);
    }
  };

  const filteredBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchFilter]);

  return (
    <div className="git-scm product-pane" data-testid="git-scm-panel">
      <header className="git-scm__toolbar">
        <div
          className="git-scm__repo"
          data-tip={workspacePath ?? undefined}
          aria-label={workspacePath ?? undefined}
        >
          <span className="git-scm__repo-path">{workspaceLabel}</span>
          <button
            type="button"
            className="git-scm__branch-btn"
            onClick={() => {
              const next = !branchMenuOpen;
              setBranchMenuOpen(next);
              if (next) {
                setBranchError(null);
                void loadBranches();
              }
            }}
            title="Trocar ou criar branch"
            aria-haspopup="dialog"
            aria-expanded={branchMenuOpen}
            aria-label={`Branch atual: ${branch ?? 'nenhuma'}. Clique para trocar.`}
          >
            <span className="git-scm__branch">{branch ?? '—'}</span>
            <span className="git-scm__branch-caret">▾</span>
          </button>
        </div>
        <div className="git-scm__toolbar-actions">
          <button
            type="button"
            className="product-pane__btn"
            onClick={() => void pull()}
            disabled={busy || !hasUpstream}
            title={hasUpstream ? (behind > 0 ? `Puxar ${behind} commits do remoto (git pull)` : 'Puxar do remoto (git pull)') : 'Sem upstream configurado'}
            aria-label="Puxar do remoto"
          >
            {pulling ? '…' : `↓${behind > 0 ? ` ${behind}` : ''}`}
          </button>
          <button
            type="button"
            className="product-pane__btn"
            onClick={() => void pushCurrentBranch()}
            disabled={busy || ahead === 0}
            title={ahead > 0 ? `Enviar ${ahead} commit(s) para o remoto (git push)` : 'Nenhum commit pendente para envio'}
            aria-label="Enviar para o remoto"
          >
            {remoteBusy ? '…' : `↑${ahead > 0 ? ` ${ahead}` : ''}`}
          </button>
          <button
            type="button"
            className="product-pane__btn"
            onClick={() => void refresh()}
            disabled={busy}
            title="Atualizar status git"
            aria-label="Atualizar status git"
          >
            ↻
          </button>
        </div>
      </header>

      {branchMenuOpen && (
        <div
          className="git-scm__branch-menu"
          role="dialog"
          aria-label="Gerenciador de Branches"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setBranchMenuOpen(false);
          }}
        >
          <div className="git-scm__branch-menu-head">
            <strong>Branches</strong>
            <button
              type="button"
              className="git-scm__link"
              onClick={() => setBranchMenuOpen(false)}
              aria-label="Fechar"
            >
              ✕
            </button>
          </div>
          <input
            className="product-pane__input git-scm__branch-filter"
            placeholder="Filtrar branches…"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            aria-label="Filtrar branches"
          />
          <div className="git-scm__branch-list" role="listbox">
            {branchesLoading ? (
              <p className="product-pane__meta">Carregando branches…</p>
            ) : filteredBranches.length === 0 ? (
              <p className="product-pane__meta">Nenhuma branch encontrada.</p>
            ) : (
              filteredBranches.map((b) => (
                <button
                  key={b}
                  type="button"
                  role="option"
                  aria-selected={b === branch}
                  className={`git-scm__branch-item${b === branch ? ' is-current' : ''}`}
                  onClick={() => void handleSwitchBranch(b)}
                >
                  <span className="git-scm__branch-item-name">{b}</span>
                  {b === branch && <span className="git-scm__branch-item-tag">atual</span>}
                </button>
              ))
            )}
          </div>
          <div className="git-scm__new-branch-form">
            <input
              className="product-pane__input"
              placeholder="Nome da nova branch"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateBranch();
              }}
              aria-label="Nome da nova branch"
            />
            <button
              type="button"
              className="product-pane__btn"
              disabled={!newBranchName.trim() || mutating}
              onClick={() => void handleCreateBranch()}
            >
              Criar
            </button>
          </div>
          {branchError && <p className="product-pane__error">{branchError}</p>}
        </div>
      )}


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
                  ? 'Nenhuma alteração pendente no working tree.'
                  : decision.title}
              </p>
              <div className="git-scm__clean-status">
                <span className="git-scm__clean-badge">
                  Branch: <strong>{branch ?? '—'}</strong>
                </span>
                {hasUpstream ? (
                  <span className="git-scm__clean-badge">
                    {ahead > 0 && behind > 0
                      ? `${ahead} à frente, ${behind} atrás`
                      : ahead > 0
                      ? `${ahead} commit(s) para enviar`
                      : behind > 0
                      ? `${behind} commit(s) para puxar`
                      : 'Sincronizado com o remoto'}
                  </span>
                ) : (
                  <span className="git-scm__clean-badge git-scm__clean-badge--dim">
                    Sem upstream configurado
                  </span>
                )}
              </div>
              <div className="git-scm__clean-actions">
                {behind > 0 && (
                  <button
                    type="button"
                    className="product-pane__btn product-pane__btn--primary"
                    disabled={busy || pulling}
                    onClick={() => void pull()}
                  >
                    {pulling ? 'Puxando…' : `Puxar ${behind} commit(s)`}
                  </button>
                )}
                {ahead > 0 && (
                  <button
                    type="button"
                    className="product-pane__btn product-pane__btn--primary"
                    disabled={busy}
                    onClick={() => void pushCurrentBranch()}
                  >
                    {remoteBusy ? 'Enviando…' : `Enviar ${ahead} commit(s)`}
                  </button>
                )}
                <button
                  type="button"
                  className="product-pane__btn"
                  onClick={() => setTab('history')}
                >
                  Ver histórico
                </button>
                <button
                  type="button"
                  className="product-pane__btn"
                  onClick={() => {
                    setBranchMenuOpen(true);
                    void loadBranches();
                  }}
                >
                  Trocar branch
                </button>
              </div>
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
                onDiscard={(path) => void discard([path])}
                onDiscardAll={() => void discard(unstaged.map((f) => f.path))}
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
                onDiscard={(path) => void discard([path])}
                onDiscardAll={() => void discard(untracked.map((f) => f.path))}
              />
            </div>
          )}

          <div className="git-scm__diff">
            <header className="git-scm__diff-head">
              <h4>Diff</h4>
              {selected && (
                <code className="git-scm__diff-path">{selected.path}</code>
              )}
              {selected && supportsHighlightedDiff() && (
                <div className="git-scm__diff-style" role="group" aria-label="Layout do diff">
                  <button
                    type="button"
                    aria-pressed={diffStyle === 'unified'}
                    onClick={() => setDiffStyle('unified')}
                  >
                    Unificado
                  </button>
                  <button
                    type="button"
                    aria-pressed={diffStyle === 'split'}
                    onClick={() => setDiffStyle('split')}
                  >
                    Lado a lado
                  </button>
                </div>
              )}
            </header>
            {selected ? (
              <GitDiffAnnotator
                diffText={diffText}
                path={selected.path}
                diffStyle={diffStyle}
                drafts={diffDrafts}
                setDrafts={setDiffDrafts}
              />
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
