import { useCallback, useEffect, useState } from 'react';
import type { PendingContextDraft } from '../../../shared/context-draft-types';

/**
 * Revisão humana de drafts de contexto. Quando não há um segundo provider CLI
 * para a revisão independente (ou o auto-review desistiu), o usuário aprova
 * aqui — a aprovação humana é registrada na atestação como a revisão
 * independente e destrava o bootstrap de contexto. A seção só aparece quando
 * existem drafts `proposed` pendentes (ou um erro/nota a mostrar).
 */
export function ContextDraftsSection() {
  const [drafts, setDrafts] = useState<PendingContextDraft[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Older preloads may not expose this API yet; stay silent like the other
    // diagnostics blocks.
    if (!window.nexus?.contextDrafts) {
      setDrafts([]);
      return;
    }
    try {
      setDrafts(await window.nexus.contextDrafts.listProposed());
      setError(null);
    } catch (cause) {
      setDrafts([]);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Falha ao listar os drafts de contexto.',
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const approve = async (draft: PendingContextDraft) => {
    if (busyId) return;
    setBusyId(draft.id);
    setError(null);
    setNote(null);
    try {
      const result = await window.nexus.contextDrafts.approve({
        draftId: draft.id,
      });
      setNote(
        result.readinessReady
          ? `${result.targetPath} aprovado e aplicado — contexto pronto para congelar o contrato.`
          : `${result.targetPath} aprovado e aplicado. ` +
              `Pendências restantes: ${result.readinessBlockers.join(', ') || '—'}.`,
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Falha ao aprovar o draft.',
      );
    } finally {
      setBusyId(null);
    }
  };

  if (!error && !note && (!drafts || drafts.length === 0)) return null;
  const pending = drafts ?? [];

  return (
    <div className="sys-group" aria-busy={busyId !== null}>
      <div className="sys-group__head">
        <div className="sys-group__titles">
          <h3 className="sys-group__title">
            Revisão de contexto pendente
          </h3>
          <p className="sys-group__hint">
            O agente propôs autoridade de contexto vinculada a fontes reais, mas
            não há um segundo provider para revisar. A sua aprovação vale como
            revisão independente e destrava o bootstrap.
          </p>
        </div>
        <span className="settings-chip settings-chip--warn">
          {pending.length} pendente(s)
        </span>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="settings-field__note" role="status">
          {note}
        </p>
      )}
      <div className="sys-group__body">
        {pending.map((draft) => (
          <div key={draft.id} className="context-draft">
            <div className="context-draft__head">
              <span className="context-draft__path">{draft.targetPath}</span>
              <span className="context-draft__meta">
                proposto por {draft.authorProvider}
                {draft.missionId ? ` · missão ${draft.missionId}` : ''}
              </span>
            </div>
            <details>
              <summary>Ver conteúdo proposto</summary>
              <pre>{draft.content}</pre>
            </details>
            <div className="context-draft__actions">
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                disabled={busyId !== null}
                onClick={() => void approve(draft)}
              >
                {busyId === draft.id
                  ? 'Aplicando…'
                  : 'Revisar e aprovar contexto'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
