import { useEffect, useRef } from 'react';
import { MISSION_INTENT_GOAL_MAX_CHARS } from '../../../shared/mission-intent';
import type { WorkspaceInfo } from '../../../shared/workspace-types';
import type { MissionSetupDraft } from '../../state/mission-setup-store';
import type { DirectAnswer } from '../../lib/direct-answer';
import { MissionAttachmentPicker } from './MissionAttachmentPicker';

interface ExpressMissionStartProps {
  workspace: WorkspaceInfo | null;
  draft: MissionSetupDraft;
  draftFieldsDisabled: boolean;
  /** Suprime o autofocus do título quando há um rascunho não lido (o alerta de
   * recuperação merece o foco). Espelha MissionStep.suppressHeadingAutofocus. */
  suppressHeadingAutofocus: boolean;
  pickingWorkspace: boolean;
  workspaceActionError: string | null;
  inventoryReady: boolean;
  /** Inventário ainda carregando: evita o flash de "conecte um provedor". */
  inventoryLoading: boolean;
  busy: boolean;
  error: string | null;
  /** Pergunta trivial já respondida pelo router — nenhuma missão nasceu. */
  directAnswer: DirectAnswer | null;
  onDismissDirectAnswer(): void;
  /** O operador insiste que aquilo é missão — bypass de 1 clique do router. */
  onStartMissionAnyway(): void;
  onPickWorkspace(): void;
  onObjectiveChange(objective: string): void;
  /** "Como vou saber que ficou pronto?" — definição de pronto do operador. */
  onAcceptanceChange(acceptance: string): void;
  onContextPathsChange(paths: readonly string[]): void;
  onStart(): void;
  onAdvanced(): void;
  /** Leva direto a Providers: o pré-requisito deixa de ser texto morto. */
  onConnectProvider(): void;
}

/**
 * Caminho Expresso (Parte C, dossiê 2026-08-11): uma tela só de "Descreva →
 * Iniciar". A equipe é auto-recomendada pelo motor existente e o modo livre já
 * vem ligado; o wizard de 3 passos continua acessível em "Avançado". Zero novo
 * canal IPC — reusa prepare+start.
 */
export function ExpressMissionStart({
  workspace,
  draft,
  draftFieldsDisabled,
  suppressHeadingAutofocus,
  pickingWorkspace,
  workspaceActionError,
  inventoryReady,
  inventoryLoading,
  busy,
  error,
  directAnswer,
  onDismissDirectAnswer,
  onStartMissionAnyway,
  onPickWorkspace,
  onObjectiveChange,
  onAcceptanceChange,
  onContextPathsChange,
  onStart,
  onAdvanced,
  onConnectProvider,
}: ExpressMissionStartProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  const draftEditingDisabled = draftFieldsDisabled || !workspace;
  const disabledReasonId = 'express-draft-disabled-reason';
  const disabledReason = workspace
    ? 'Resolva o carregamento do rascunho antes de preencher os dados da missão.'
    : 'Escolha uma pasta de projeto para preencher os dados da missão.';

  useEffect(() => {
    if (!suppressHeadingAutofocus) headingRef.current?.focus();
  }, [suppressHeadingAutofocus]);

  const teamNames = draft.roster
    .map((agent) => agent.agentName)
    .filter(Boolean);

  return (
    <section
      className="mission-setup__step"
      aria-labelledby="express-mission-title"
    >
      <header className="mission-setup__step-header">
        <p className="mission-setup__step-kicker">Caminho Expresso</p>
        <h1 id="express-mission-title" ref={headingRef} tabIndex={-1}>
          Descreva e pronto
        </h1>
        <p>
          Escreva o que você quer entregar. A equipe é escolhida
          automaticamente com a ferramenta conectada e a revisão acontece sem
          tela extra.
        </p>
      </header>

      <div className="mission-setup__continuous-section">
        <div className="mission-setup__field mission-setup__workspace-field">
          <label htmlFor="express-workspace-path">Pasta do projeto</label>
          <div className="mission-setup__workspace-control">
            <input
              id="express-workspace-path"
              type="text"
              value={workspace?.path ?? 'Nenhuma pasta escolhida'}
              readOnly
              aria-invalid={Boolean(workspaceActionError)}
              aria-describedby={[
                workspaceActionError ? 'express-workspace-error' : null,
                draftEditingDisabled ? disabledReasonId : null,
              ]
                .filter(Boolean)
                .join(' ')}
            />
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onPickWorkspace}
              disabled={pickingWorkspace || busy}
              aria-describedby={
                draftEditingDisabled ? disabledReasonId : undefined
              }
            >
              {pickingWorkspace ? 'Escolhendo pasta…' : 'Escolher pasta'}
            </button>
          </div>
          {workspaceActionError && (
            <p
              id="express-workspace-error"
              className="mission-setup__inline-error mission-setup__focus-message"
              role="alert"
              aria-atomic="true"
              tabIndex={-1}
            >
              {workspaceActionError}
            </p>
          )}
          {draftEditingDisabled && (
            <p id={disabledReasonId} className="mission-setup__hint">
              {disabledReason}
            </p>
          )}
        </div>

        <div className="mission-setup__field mission-setup__objective-field">
          <label htmlFor="express-objective">
            O que você quer que a missão entregue?
          </label>
          <textarea
            id="express-objective"
            value={draft.objective}
            rows={8}
            maxLength={MISSION_INTENT_GOAL_MAX_CHARS}
            placeholder="Exemplo: refaça o fluxo de cadastro para ficar simples no celular e confirme que ele funciona do início ao fim."
            disabled={draftEditingDisabled || busy}
            aria-describedby="express-objective-hint"
            onChange={(event) => {
              if (draftEditingDisabled) return;
              onObjectiveChange(event.target.value);
            }}
          />
          <span id="express-objective-hint" className="mission-setup__hint">
            Escreva em linguagem comum. A missão começa assim que você confirmar.
          </span>
        </div>

        <div className="mission-setup__field">
          <label htmlFor="express-acceptance">
            Como vou saber que ficou pronto?
          </label>
          <input
            id="express-acceptance"
            type="text"
            value={draft.acceptance ?? ''}
            maxLength={2048}
            placeholder="Exemplo: a página abre no celular e o botão de contato funciona."
            disabled={draftEditingDisabled || busy}
            aria-describedby="express-acceptance-hint"
            onChange={(event) => {
              if (draftEditingDisabled) return;
              onAcceptanceChange(event.target.value);
            }}
          />
          <span id="express-acceptance-hint" className="mission-setup__hint">
            Opcional, mas é o que a equipe usa para conferir a entrega antes de
            dizer que terminou.
          </span>
        </div>

        <MissionAttachmentPicker
          contextPaths={draft.contextPaths}
          disabled={draftEditingDisabled || busy}
          onContextPathsChange={onContextPathsChange}
        />

        {draft.roster.length > 0 ? (
          <div className="mission-setup__section-heading">
            <div>
              <h2>Equipe automática</h2>
              <p>
                Papéis escolhidos com a ferramenta conectada. O modo livre já
                vem ligado.
              </p>
            </div>
            <span className="mission-setup__count-chip">
              {teamNames.length} {teamNames.length === 1 ? 'papel' : 'papéis'}
            </span>
          </div>
        ) : inventoryLoading ? (
          <p className="mission-setup__hint">
            Verificando as ferramentas de IA conectadas…
          </p>
        ) : null}

        {/* Independente do roster: um rascunho antigo com equipe salva e o
            login vencido caía num beco — "Equipe automática" na tela, nenhuma
            rota para Providers, e o Iniciar apontando para um botão ausente. */}
        {!inventoryLoading && !inventoryReady ? (
            <div
              className="mission-setup__section-heading"
              id="express-provider-block"
            >
              <div>
                <h2>Falta conectar uma ferramenta de IA</h2>
                <p>
                  O Nexus precisa de pelo menos uma ferramenta de IA (Claude,
                  Codex, Gemini…) para trabalhar por você.
                </p>
              </div>
              <button
                type="button"
                className="mission-setup__button mission-setup__button--primary"
                onClick={onConnectProvider}
                disabled={busy}
              >
                Conectar uma ferramenta de IA
              </button>
            </div>
        ) : null}
      </div>

      {directAnswer && (
        <div
          className="mission-setup__direct-answer"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <p className="mission-setup__direct-answer-kicker">
            Resposta direta — nenhuma missão foi criada
          </p>
          <p className="mission-setup__direct-answer-question">
            {directAnswer.question}
          </p>
          <p className="mission-setup__direct-answer-body">
            {directAnswer.answer}
          </p>
          <div className="mission-setup__direct-answer-actions">
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onDismissDirectAnswer}
            >
              Entendido
            </button>
            <button
              type="button"
              className="mission-setup__button mission-setup__button--quiet"
              onClick={onStartMissionAnyway}
              disabled={busy}
            >
              Criar missão mesmo assim
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          className="mission-setup__error-summary"
          role="alert"
          aria-live="polite"
          aria-atomic="true"
        >
          {error}
        </div>
      )}

      <footer className="mission-setup__step-actions mission-setup__step-actions--end">
        <button
          type="button"
          className="mission-setup__button mission-setup__button--primary"
          onClick={onStart}
          disabled={busy}
        >
          {busy ? 'Iniciando missão…' : 'Iniciar missão'}
        </button>
        <button
          type="button"
          className="mission-setup__button mission-setup__button--quiet"
          onClick={onAdvanced}
          disabled={busy}
        >
          Avançado
        </button>
      </footer>
    </section>
  );
}
