import { useEffect, useMemo, useRef, useState } from 'react';
import { sendAnnotationsToAgent } from '../lib/agent-attach';
import {
  clearEphemeralDraft,
  peekEphemeralDraft,
  saveEphemeralDraft,
} from '../state/ephemeral-draft-store';
import { createDraftHydrationBarrier } from '../lib/ui-overlay-policy';
import { CloseButton } from './CloseButton';

type Annotation = { path: string; line: number; body: string; id: string };

type DiffAnnotateDraft = {
  annotations: Annotation[];
  draft: string;
  selected: { path: string; line: number } | null;
};

/**
 * Minimal AI-diff review: load git diff, click a line to annotate, send to agent (A3).
 * Annotations + draft text soft-persist so closing the panel / Jarvis mis-click
 * does not wipe review notes mid-write.
 */
export function DiffAnnotatePanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const draftHydrationBarrier = useRef(createDraftHydrationBarrier()).current;
  const [diff, setDiff] = useState('');
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<{ path: string; line: number } | null>(
    null,
  );
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    draftHydrationBarrier.markHydrating();
    const saved = peekEphemeralDraft<DiffAnnotateDraft>('diff-annotate');
    if (saved) {
      setAnnotations(saved.annotations);
      setDraft(saved.draft);
      setSelected(saved.selected);
    } else {
      // Fresh open without pocketed notes — clear local leftovers from a
      // previous hard-cleared session in the same mounted panel instance.
      setAnnotations([]);
      setDraft('');
      setSelected(null);
    }
    setNote(null);
    setLoading(true);
    setError(null);
    void window.nexus.integrations
      .gitDiff()
      .then((r) => {
        if (!r.ok) {
          setError(r.error);
          setDiff('');
          return;
        }
        setDiff(r.diff || '(sem alterações em relação a HEAD)');
        setBranch(r.branch);
      })
      .finally(() => setLoading(false));
  }, [open, draftHydrationBarrier]);

  useEffect(() => {
    if (!open) return;
    if (draftHydrationBarrier.shouldSkipPersist()) return;
    saveEphemeralDraft<DiffAnnotateDraft>('diff-annotate', {
      annotations,
      draft,
      selected,
    });
  }, [open, annotations, draft, selected, draftHydrationBarrier]);

  const lines = useMemo(() => diff.split('\n'), [diff]);

  if (!open) return null;

  let currentPath = '';
  let hunkNewLine = 0;

  return (
    <div className="diff-panel" role="dialog" aria-label="Diff e anotações">
      <header className="diff-panel__head">
        <div>
          <strong>Diff → Agent</strong>
          <span className="diff-panel__meta">
            {branch ? `branch ${branch}` : 'git'} · {annotations.length} nota(s)
          </span>
        </div>
        <CloseButton onClick={onClose} label="Fechar painel de diff" />
      </header>
      {loading && <p className="diff-panel__status">A carregar diff…</p>}
      {error && <p className="diff-panel__err">{error}</p>}
      <div className="diff-panel__body">
        <pre className="diff-panel__diff">
          {lines.map((line, i) => {
            if (line.startsWith('+++ b/')) {
              currentPath = line.slice(6).trim();
            } else if (line.startsWith('@@')) {
              const m = /\+(\d+)/.exec(line);
              hunkNewLine = m ? Number(m[1]) - 1 : 0;
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
              hunkNewLine += 1;
            } else if (line.startsWith(' ')) {
              hunkNewLine += 1;
            }
            const isPlus = line.startsWith('+') && !line.startsWith('+++');
            const path = currentPath;
            const lineNo = hunkNewLine;
            return (
              <button
                key={i}
                type="button"
                className={`diff-panel__line ${isPlus ? 'diff-panel__line--add' : ''} ${
                  selected?.path === path && selected?.line === lineNo
                    ? 'diff-panel__line--sel'
                    : ''
                }`}
                onClick={() => {
                  if (!path || !isPlus) return;
                  setSelected({ path, line: lineNo });
                }}
                title={isPlus ? `${path}:${lineNo} — clicar para anotar` : undefined}
              >
                {line || ' '}
              </button>
            );
          })}
        </pre>
        <aside className="diff-panel__side">
          <label className="diff-panel__label">
            Anotar linha
            <span className="diff-panel__sel">
              {selected
                ? `${selected.path}:${selected.line}`
                : 'clique numa linha + no diff'}
            </span>
          </label>
          <textarea
            className="diff-panel__input"
            rows={4}
            value={draft}
            placeholder="Comentário para o agent…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="diff-panel__btn"
            disabled={!selected || !draft.trim()}
            onClick={() => {
              if (!selected || !draft.trim()) return;
              setAnnotations((prev) => [
                ...prev,
                {
                  id: `${Date.now()}`,
                  path: selected.path,
                  line: selected.line,
                  body: draft.trim(),
                },
              ]);
              setDraft('');
            }}
          >
            Adicionar nota
          </button>
          <ul className="diff-panel__notes">
            {annotations.map((a) => (
              <li key={a.id}>
                <code>
                  {a.path}:{a.line}
                </code>{' '}
                {a.body}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="diff-panel__btn diff-panel__btn--primary"
            disabled={annotations.length === 0 || sending}
            onClick={() => {
              setSending(true);
              setNote(null);
              void sendAnnotationsToAgent(annotations)
                .then((ok) => {
                  setNote(
                    ok
                      ? 'Revisão entregue — a missão vai endereçar os comentários'
                      : 'Falha — o terminal do orquestrador não está disponível',
                  );
                  if (ok) {
                    setAnnotations([]);
                    setDraft('');
                    setSelected(null);
                    clearEphemeralDraft('diff-annotate');
                  }
                })
                .finally(() => setSending(false));
            }}
          >
            {sending ? 'Enviando…' : 'Enviar revisão à missão'}
          </button>
          {note && <p className="diff-panel__status">{note}</p>}
        </aside>
      </div>
    </div>
  );
}
