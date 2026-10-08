import { useEffect, useState } from 'react';
import {
  APPROVAL_DEGRADED_NOTE,
  APPROVAL_OPTION_LABELS,
  type ApprovalDecision,
  type ApprovalOption,
} from '../../shared/approval-decision';
import { useApprovalRequestFor, useApprovalSurface } from '../lib/approval-requests';
import { getPaneSessionId, onPaneSessionChange } from '../terminal/terminal-host';

const REJECT_COPY: Record<string, string> = {
  'stale-revision': 'O pedido mudou. Confira o terminal.',
  'already-resolved': 'Este pedido já foi respondido.',
  closed: 'O pedido expirou ou já foi respondido no terminal.',
  'unknown-request': 'O pedido expirou ou já foi respondido no terminal.',
  'option-unavailable': 'Esta opção não vale para este pedido.',
};

const OPTION_TONE: Record<ApprovalDecision, string> = {
  accept: 'pane-approval__btn--primary',
  acceptForSession: 'pane-approval__btn--ghost',
  decline: 'pane-approval__btn--danger',
  cancel: 'pane-approval__btn--danger',
};

/**
 * Card de aprovação do pane (PRV-02). Montado só em pane de agente VISÍVEL:
 * enquanto ele existe, o hook PermissionRequest daquela sessão espera a
 * decisão aqui (até o prazo do broker). O diálogo da TUI continua desenhado
 * e aceitando tecla — a sonda provou que quem responder primeiro vence —,
 * por isso o card diz que o terminal também serve.
 */
export function PaneApprovalCard({ paneId, visible }: { paneId: string; visible: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(() => getPaneSessionId(paneId));
  const [pendingOption, setPendingOption] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSessionId(getPaneSessionId(paneId));
    return onPaneSessionChange((id, next) => {
      if (id === paneId) setSessionId(next);
    });
  }, [paneId]);

  useApprovalSurface(sessionId, visible);
  const request = useApprovalRequestFor(sessionId);
  const requestId = request?.requestId ?? null;

  useEffect(() => {
    setPendingOption(null);
    setError(null);
  }, [requestId]);

  if (!request) return null;

  const respond = async (option: ApprovalOption) => {
    setPendingOption(option.optionId);
    setError(null);
    try {
      const result = await window.nexus.approvals.respond({
        requestId: request.requestId,
        expectedRevision: request.revision,
        optionId: option.optionId,
      });
      if (result.status !== 'accepted') {
        setError(REJECT_COPY[result.reason ?? ''] ?? 'Resposta recusada. Use o terminal.');
        setPendingOption(null);
      }
    } catch {
      setError('Resposta não enviada. Use o terminal.');
      setPendingOption(null);
    }
  };

  const degraded = request.options.some((option) => option.degradesTo);
  const titleId = `pane-approval-${request.requestId}`;
  return (
    <section className="pane-approval" role="group" aria-labelledby={titleId}>
      <div className="pane-approval__head">
        <span className="pane-approval__dot" aria-hidden="true" />
        <strong id={titleId} className="pane-approval__title">
          Aprovação pendente
        </strong>
        <span className="pane-approval__tool">{request.tool}</span>
      </div>
      {request.summary ? <code className="pane-approval__summary">{request.summary}</code> : null}
      <div className="pane-approval__actions">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={`pane-approval__btn ${OPTION_TONE[option.optionId]}`}
            disabled={pendingOption !== null}
            aria-busy={pendingOption === option.optionId}
            onClick={() => void respond(option)}
          >
            {APPROVAL_OPTION_LABELS[option.optionId]}
          </button>
        ))}
      </div>
      <p className="pane-approval__note">
        {degraded ? `${APPROVAL_DEGRADED_NOTE} ` : ''}O terminal também aceita a resposta.
      </p>
      {error ? (
        <p className="pane-approval__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
