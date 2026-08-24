import { useEffect, useRef } from 'react';
import { MISSION_INTENT_GOAL_MAX_CHARS } from '../../../shared/mission-intent';
import type { SquadAgent } from '../../../shared/orch-types';
import type { WorkspaceInfo } from '../../../shared/workspace-types';
import type { MissionSetupDraft } from '../../state/mission-setup-store';
import type { DirectAnswer } from '../../lib/direct-answer';
import { MissionAttachmentPicker } from './MissionAttachmentPicker';
import { MissionSetupRosterRow } from './MissionSetupRosterRow';
import { issueForAgent, type MissionTeamInventory } from './TeamStep';
import { useObjectiveDictation } from './use-objective-dictation';

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
  inventory: MissionTeamInventory;
  onRosterChange(roster: readonly SquadAgent[]): void;
}

/**
 * Caminho Expresso: descreva o objetivo, escolha a Ferramenta de cada papel,
 * Iniciar. O wizard de 3 passos continua em "Mais papéis e tamanho". Zero
 * novo canal IPC — reusa prepare+start com o roster que está na tela.
 */
/**
 * Três pedidos reais, de tamanhos diferentes: uma correção pequena, uma tela
 * nova e uma publicação. Cobrem as três formas mais comuns de trabalho e
 * mostram o nível de detalhe que ajuda a equipe.
 */
const OBJECTIVE_EXAMPLES: ReadonlyArray<{
  readonly label: string;
  readonly text: string;
}> = [
  {
    label: 'Corrigir algo',
    text: 'o botão de enviar do formulário não funciona no celular; corrija e confirme que dá para enviar do começo ao fim',
  },
  {
    label: 'Criar uma tela',
    text: 'crie uma página de contato simples com nome, e-mail e mensagem, no mesmo estilo do resto do site',
  },
  {
    label: 'Publicar',
    text: 'publique o site e me diga o endereço para eu abrir no navegador',
  },
];

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
  inventory,
  onRosterChange,
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

  const dictation = useObjectiveDictation({
    enabled: !draftEditingDisabled && !busy,
    onTranscript: (text) => {
      const current = draft.objective;
      const next =
        current.trim().length > 0
          ? `${current.replace(/\s+$/u, '')} ${text}`
          : text;
      onObjectiveChange(next.slice(0, MISSION_INTENT_GOAL_MAX_CHARS));
    },
  });

  return (
    <section
      className="mission-setup__step mission-setup__step--express"
      aria-labelledby="express-mission-title"
    >
      <header className="mission-setup__step-header">
        <p className="mission-setup__step-kicker">Caminho Expresso</p>
        <h1 id="express-mission-title" ref={headingRef} tabIndex={-1}>
          Descreva e pronto
        </h1>
        <p>
          Escreva o que você quer entregar. Em seguida escolha qual ferramenta
          faz cada papel — Iniciar usa exatamente o que estiver aqui.
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
          <div className="mission-setup__objective-label-row">
            <label htmlFor="express-objective">
              O que você quer que a missão entregue?
            </label>
            <button
              type="button"
              className={`mission-setup__button mission-setup__button--secondary mission-setup__dictation-button${
                dictation.state === 'listening'
                  ? ' mission-setup__dictation-button--live'
                  : ''
              }`}
              aria-pressed={dictation.state === 'listening'}
              disabled={
                !dictation.available ||
                draftEditingDisabled ||
                busy ||
                dictation.state === 'busy'
              }
              onClick={dictation.toggle}
              title={
                !dictation.available
                  ? 'Ligue o microfone em Configurações › Voz para ditar o objetivo'
                  : dictation.state === 'listening'
                    ? 'Clique para parar e transcrever no objetivo'
                    : 'Fale o objetivo — o Nexus transcreve aqui (ou segure Espaço fora dos campos de texto)'
              }
            >
              {dictation.state === 'listening'
                ? '◼ Parar e transcrever'
                : dictation.state === 'busy'
                  ? 'Transcrevendo…'
                  : 'Ditar objetivo'}
            </button>
          </div>
          <textarea
            id="express-objective"
            value={draft.objective}
            rows={2}
            maxLength={MISSION_INTENT_GOAL_MAX_CHARS}
            placeholder="Exemplo: refaça o fluxo de cadastro para ficar simples no celular e confirme que ele funciona do início ao fim."
            disabled={draftEditingDisabled || busy}
            aria-describedby="express-objective-hint"
            onChange={(event) => {
              if (draftEditingDisabled) return;
              onObjectiveChange(event.target.value);
            }}
          />
          <span id="express-objective-hint" className="mission-setup__sr-only">
            Escreva em linguagem comum. A missão começa assim que você confirmar.
          </span>
          {/* O produto nunca mostrava um objetivo que FUNCIONOU. Quem não
              programa trava na folha em branco: não sabe o tamanho, o nível de
              detalhe, nem o tipo de pedido que cabe. Os exemplos continuam na
              tela depois da primeira tecla — servem de régua, não só de
              partida. */}
          <div
            className="mission-setup__examples"
            role="group"
            aria-label="Exemplos de objetivo"
          >
            {OBJECTIVE_EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                className="mission-setup__example"
                disabled={draftEditingDisabled || busy}
                onClick={() => onObjectiveChange(example.text)}
                title={example.text}
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>

        <MissionAttachmentPicker
          contextPaths={draft.contextPaths}
          disabled={draftEditingDisabled || busy}
          onContextPathsChange={onContextPathsChange}
        />

        {draft.roster.length > 0 ? (
          <>
            <div className="mission-setup__section-heading">
              <div>
                <h2>Quem faz o quê</h2>
              </div>
              <span className="mission-setup__count-chip">
                {teamNames.length} {teamNames.length === 1 ? 'papel' : 'papéis'}
              </span>
            </div>
            {inventory.status === 'ready' ? (
              <ul
                className="mission-roster mission-roster--compact"
                aria-label="Quem faz o quê"
              >
                {draft.roster.map((agent) => (
                  <MissionSetupRosterRow
                    key={agent.id}
                    agent={agent}
                    candidates={
                      agent.category === 'orchestrator'
                        ? inventory.readiness.verifiedMaestros
                        : inventory.readiness.qualifiedWorkers
                    }
                    providers={inventory.providers}
                    accounts={inventory.accounts}
                    issue={issueForAgent(agent, inventory)}
                    removable={false}
                    compact
                    onChange={(next) =>
                      onRosterChange(
                        draft.roster.map((item) =>
                          item.id === next.id ? next : item,
                        ),
                      )
                    }
                    onRemove={() => undefined}
                  />
                ))}
              </ul>
            ) : null}
          </>
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

      <footer className="mission-setup__step-actions mission-setup__step-actions--end mission-setup__step-actions--after-content">
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
          Mais papéis e tamanho
        </button>
      </footer>

      <div className="mission-setup__continuous-section">
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
      </div>
    </section>
  );
}
