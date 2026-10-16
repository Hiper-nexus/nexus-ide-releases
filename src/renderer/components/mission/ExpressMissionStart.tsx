import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { MISSION_INTENT_GOAL_MAX_CHARS } from '../../../shared/mission-intent';
import type { SquadAgent } from '../../../shared/orch-types';
import type { WorkspaceInfo } from '../../../shared/workspace-types';
import type { MissionSetupDraft } from '../../state/mission-setup-store';
import type { DirectAnswer } from '../../lib/direct-answer';
import { ExpressTerminalOptions } from './ExpressTerminalOptions';
import { FirstStepsGuide } from '../onboarding/FirstStepsGuide';
import { useMissionAttachmentPresentation } from '../../state/mission-attachment-presentation';
import { isMissionContextAttachmentPath } from '../../lib/mission-attachments';
import { MissionAttachmentPicker } from './MissionAttachmentPicker';
import { MissionSetupRosterRow } from './MissionSetupRosterRow';
import { issueForAgent, type MissionTeamInventory } from './TeamStep';
import { useObjectiveDictation } from './use-objective-dictation';
import { PixelIcon } from '../PixelIcon';
import { launcherShortcutHint } from '../../lib/action-names';
import { formatShortcut } from '../../lib/platform';
import { usePendingOrchestratorAdoptionStore } from '../../state/pending-orchestrator-adoption-store';
import {
  ComposerTiptapEditor,
  plainTextToMarkdown,
  truncateMarkdown,
  type ComposerTiptapEditorHandle,
} from '../ComposerTiptapEditor';

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
 * Pedidos de exemplo, de tamanhos e riscos diferentes: criar uma tela, corrigir
 * algo, só entender o projeto (leitura, a lane `consult`) e publicar. Cobrem as
 * formas mais comuns de trabalho e mostram o nível de detalhe que ajuda a
 * equipe. Cada texto é conferido contra `suggestMissionLaneFromGoal` no teste.
 */
const OBJECTIVE_EXAMPLES: ReadonlyArray<{
  readonly label: string;
  readonly text: string;
}> = [
  {
    label: 'Criar uma tela',
    text: 'crie uma página de contato simples com nome, e-mail e mensagem, no mesmo estilo do resto do site',
  },
  {
    label: 'Corrigir algo',
    text: 'o botão de enviar do formulário não funciona no celular; corrija e confirme que dá para enviar do começo ao fim',
  },
  {
    label: 'Entender o projeto',
    text: 'me explique como este projeto funciona e o que dá para melhorar; só me diga, sem alterar nada',
  },
  {
    label: 'Publicar',
    text: 'publique o site e me diga o endereço para eu abrir no navegador',
  },
];

const OBJECTIVE_REQUIRED_MESSAGE =
  'Escreva o que você quer criar para poder começar.';

interface ObjectiveError {
  readonly message: string;
  readonly sequence: number;
}

/**
 * Objetivo primeiro; equipe e referências podem ser personalizadas sem
 * mudar o rascunho ao abrir opções. Reusa prepare+start com o roster salvo.
 *
 * A ação "Iniciar criação" mora no dock (irmão da área rolável, mesma receita
 * da Equipe e da Revisão): sempre à vista, com o atalho ⌘/Ctrl+Enter ao lado,
 * por mais longa que fique a página de apoio embaixo do formulário.
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
  inventory,
  onRosterChange,
}: ExpressMissionStartProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const objectiveRef = useRef<ComposerTiptapEditorHandle>(null);
  const errorSequenceRef = useRef(0);
  // Exemplo aplicado sobre um texto do operador: guarda o texto trocado para
  // oferecer "Desfazer". `appliedExampleRef` diz qual exemplo está na tela; se
  // o operador digitar por cima, a chance de desfazer some junto.
  const appliedExampleRef = useRef<string | null>(null);
  const focusAfterChangeRef = useRef(false);
  const [objectiveError, setObjectiveError] = useState<ObjectiveError | null>(
    null,
  );
  const [replacedObjective, setReplacedObjective] = useState<string | null>(
    null,
  );
  // Adoção pendente (F-561): o operador chegou aqui clicando "Tornar
  // orquestrador" num terminal. Sem este aviso ele cai numa tela de criação de
  // missão sem entender por quê.
  const pendingAdoption = usePendingOrchestratorAdoptionStore(
    (state) => state.pending,
  );

  const draftEditingDisabled = draftFieldsDisabled;
  const disabledReasonId = 'express-draft-disabled-reason';
  const disabledReason =
    'Resolva o carregamento do rascunho antes de preencher os dados da missão.';
  const needsWorkspace = !workspace;

  // O anexo colado no campo de texto vive dentro de "detalhes": sem abrir o
  // painel, a imagem colada não aparecia em lugar nenhum.
  const deliveryDetailsRef = useRef<HTMLDetailsElement>(null);
  const attachmentCount =
    draft.contextPaths.filter(isMissionContextAttachmentPath).length +
    useMissionAttachmentPresentation((state) => state.pending.length);
  useEffect(() => {
    if (attachmentCount > 0 && deliveryDetailsRef.current) {
      deliveryDetailsRef.current.open = true;
    }
  }, [attachmentCount]);

  useEffect(() => {
    if (!suppressHeadingAutofocus) headingRef.current?.focus();
  }, [suppressHeadingAutofocus]);

  // O erro do pedido vazio já está na tela quando o foco chega ao campo.
  useEffect(() => {
    if (objectiveError) objectiveRef.current?.focus();
  }, [objectiveError]);

  useEffect(() => {
    if (focusAfterChangeRef.current) {
      focusAfterChangeRef.current = false;
      objectiveRef.current?.focusEnd();
    }
    if (
      appliedExampleRef.current !== null &&
      draft.objective !== appliedExampleRef.current
    ) {
      appliedExampleRef.current = null;
      setReplacedObjective(null);
    }
  }, [draft.objective]);

  const maestro = draft.roster.find(
    (agent) => agent.category === 'orchestrator',
  );
  const maestroIssue =
    inventory.status === 'ready' && maestro
      ? issueForAgent(maestro, inventory)
      : null;
  const startBlocked = Boolean(maestroIssue);
  const providerMissing =
    !inventoryLoading && !inventoryReady && !maestroIssue;

  // Um só caminho para clique, Enter em campo de uma linha e ⌘/Ctrl+Enter.
  // Sem pasta, iniciar vira "escolher a pasta" (o pedido espera no rascunho);
  // com pasta, pedido vazio é explicado no próprio campo.
  const requestStart = (): void => {
    if (busy || startBlocked) return;
    if (!needsWorkspace && !draft.objective.trim()) {
      errorSequenceRef.current += 1;
      setObjectiveError({
        message: OBJECTIVE_REQUIRED_MESSAGE,
        sequence: errorSequenceRef.current,
      });
      return;
    }
    onStart();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    requestStart();
  };

  // O Tiptap lê ⌘/Ctrl+Enter como quebra de linha. Em CAPTURA, antes de o
  // editor ver a tecla, ela vira "iniciar" (Enter e Shift+Enter seguem
  // quebrando linha). Nunca durante a composição do IME.
  const handleKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLFormElement>,
  ): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    if (!(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    requestStart();
  };

  const applyExample = (text: string): void => {
    const previous = draft.objective;
    if (text === previous) {
      objectiveRef.current?.focusEnd();
      return;
    }
    const hasText = previous.trim().length > 0;
    const typedByOperator =
      hasText &&
      !OBJECTIVE_EXAMPLES.some((example) => example.text === previous.trim());
    // Trocar de um exemplo para outro não pode perder o texto que a pessoa
    // escreveu antes do primeiro exemplo: o "Desfazer" segue apontando para ele.
    setReplacedObjective(
      typedByOperator ? previous : hasText ? replacedObjective : null,
    );
    appliedExampleRef.current = text;
    focusAfterChangeRef.current = true;
    setObjectiveError(null);
    onObjectiveChange(text);
  };

  const undoExample = (): void => {
    if (replacedObjective === null) return;
    const restored = replacedObjective;
    appliedExampleRef.current = null;
    focusAfterChangeRef.current = true;
    setReplacedObjective(null);
    onObjectiveChange(restored);
  };

  const teamSize = draft.roster.length;
  const teamTools = [
    ...new Set(
      draft.roster.map(
        (agent) =>
          inventory.adapters.find((adapter) => adapter.id === agent.cli)
            ?.label ?? agent.cli,
      ),
    ),
  ];

  const dictation = useObjectiveDictation({
    enabled: !draftEditingDisabled && !busy,
    onTranscript: (text) => {
      const current = draft.objective;
      // F-1170: o objetivo é markdown; a fala entra como texto literal.
      const spoken = plainTextToMarkdown(text);
      const next =
        current.trim().length > 0
          ? `${current.replace(/\s+$/u, '')} ${spoken}`
          : spoken;
      if (spoken.trim()) setObjectiveError(null);
      // Revisão P3: corte por unidades seguras (nunca no meio de um escape).
      onObjectiveChange(truncateMarkdown(next, MISSION_INTENT_GOAL_MAX_CHARS));
    },
  });

  const submitShortcut = formatShortcut('mod', 'enter');
  const objectiveDescribedBy = [
    'express-objective-hint',
    objectiveError ? 'express-objective-error' : null,
  ]
    .filter(Boolean)
    .join(' ');
  // Quem vai trabalhar e onde, à vista no momento de decidir: o clique de maior
  // risco da tela não pode ser um botão sem contexto.
  const dockNote: ReactNode = busy ? (
    'Preparando a missão…'
  ) : workspace ? (
    <>
      <strong>{workspace.name}</strong>
      {teamSize > 0 ? (
        <span>
          {' · '}
          {teamSize} {teamSize === 1 ? 'agente' : 'agentes'} ·{' '}
          {teamTools.join(' · ')}
        </span>
      ) : null}
    </>
  ) : (
    'Escolha a pasta do projeto para poder iniciar.'
  );

  return (
    <form
      className="mission-setup__step mission-setup__step--express mission-setup__step--docked"
      aria-labelledby="express-mission-title"
      aria-busy={busy || undefined}
      onSubmit={handleSubmit}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div className="mission-setup__step-scroll">
      <header className="mission-setup__step-header">
        <h1 id="express-mission-title" ref={headingRef} tabIndex={-1}>
          O que você quer criar?
        </h1>
        <p>
            Conte sua ideia ou o que precisa melhorar. O Nexus organiza a
            equipe para trabalhar no seu projeto.
        </p>
      </header>

      {pendingAdoption ? (
        <p className="mission-setup__adoption-notice" role="status">
          <PixelIcon name="crown" size={12} />
          <span>
            <strong>
              {pendingAdoption.paneTitle?.trim() || 'O painel escolhido'}
            </strong>{' '}
              vai coordenar esta missão. Nenhum terminal novo é aberto — falta
              só dizer o que ela deve entregar.
          </span>
        </p>
      ) : null}

      <div className="mission-setup__continuous-section">
        <div className="mission-setup__field mission-setup__objective-field">
          <div className="mission-setup__objective-label-row">
              {/* F-1170: editor rich-text nomeado por aria-labelledby. O rótulo
                  aponta para um contenteditable, que o navegador não foca
                  sozinho: clicar no rótulo foca o campo. */}
              <label
                id="express-objective-label"
                htmlFor="express-objective"
                onClick={() => objectiveRef.current?.focus()}
              >
              Seu pedido
            </label>
            <kbd
              className="launcher-action__shortcut"
              data-launcher-action="mission"
              aria-hidden="true"
            >
              {launcherShortcutHint('mission')}
            </kbd>
            </div>
            <ComposerTiptapEditor
              ref={objectiveRef}
              id="express-objective"
              className="mission-setup__objective-editor"
              surfaceClassName="mission-setup__objective-draft mission-setup__objective-draft--express"
              toolbar={false}
              value={draft.objective}
              maxLength={MISSION_INTENT_GOAL_MAX_CHARS}
              placeholder="Exemplo: quero um site para a minha confeitaria, com cardápio e botão de WhatsApp. Tem que abrir bem no celular."
              editable={!(draftEditingDisabled || busy)}
              ariaLabelledBy="express-objective-label"
              ariaInvalid={Boolean(objectiveError)}
              ariaDescribedBy={objectiveDescribedBy}
              onChange={(markdown) => {
                if (draftEditingDisabled) return;
                if (markdown.trim()) setObjectiveError(null);
                onObjectiveChange(markdown);
              }}
            />
            <div className="mission-setup__objective-help">
              <p id="express-objective-hint" className="mission-setup__hint">
                Diga o que você quer, para quem é e como vai saber que ficou
                pronto. Pode começar simples e pedir ajustes depois.
              </p>
            <button
              type="button"
              className={`mission-setup__button mission-setup__button--secondary mission-setup__dictation-button${
                dictation.state === 'listening'
                  ? ' mission-setup__dictation-button--live'
                  : ''
              }`}
              aria-pressed={dictation.state === 'listening'}
                aria-describedby={
                  dictation.available ? undefined : 'express-dictation-reason'
                }
              disabled={
                !dictation.available ||
                draftEditingDisabled ||
                busy ||
                dictation.state === 'busy'
              }
              onClick={dictation.toggle}
              title={
                !dictation.available
                    ? 'Ligue o microfone em Configurações › Voz para ditar o pedido'
                  : dictation.state === 'listening'
                      ? 'Clique para parar e transcrever no pedido'
                      : 'Fale o pedido — o Nexus transcreve aqui (ou segure Espaço fora dos campos de texto)'
              }
            >
                <PixelIcon
                  name={dictation.state === 'listening' ? 'stop' : 'mic'}
                  size={12}
                />
              {dictation.state === 'listening'
                  ? 'Parar e transcrever'
                : dictation.state === 'busy'
                  ? 'Transcrevendo…'
                    : 'Ditar pedido'}
            </button>
              {!dictation.available ? (
                <span
                  id="express-dictation-reason"
                  className="mission-setup__sr-only"
                >
                  Para ditar, ligue o microfone em Configurações, Voz.
          </span>
              ) : null}
            </div>
            {objectiveError && (
              <p
                key={objectiveError.sequence}
                id="express-objective-error"
                className="mission-setup__inline-error"
                role="alert"
                aria-atomic="true"
              >
                {objectiveError.message}
              </p>
            )}
            {/* O produto nunca mostrava um pedido que FUNCIONOU. Quem não
                programa trava na folha em branco: não sabe o tamanho, o nível
                de detalhe, nem o tipo de pedido que cabe. Os exemplos ficam na
                tela depois da primeira tecla; clicar num deles troca o texto
                (e "Desfazer" devolve o que foi digitado). */}
          <div
            className="mission-setup__examples"
            role="group"
              aria-labelledby="express-examples-caption"
          >
              <span
                id="express-examples-caption"
                className="mission-setup__examples-caption"
              >
                Comece por um exemplo:
              </span>
            {OBJECTIVE_EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                className="mission-setup__example"
                disabled={draftEditingDisabled || busy}
                  onClick={() => applyExample(example.text)}
                title={example.text}
              >
                {example.label}
              </button>
            ))}
          </div>
            <p
              className="mission-setup__hint mission-setup__undo"
              role="status"
              aria-live="polite"
            >
              {replacedObjective !== null ? (
                <>
                  O exemplo entrou no lugar do seu texto.{' '}
                  <button
                    type="button"
                    className="mission-setup__button mission-setup__button--quiet"
                    onClick={undoExample}
                  >
                    Desfazer
                  </button>
                </>
              ) : null}
            </p>
          </div>

          {/* Anexos fora do recolher: imagem, áudio e arquivo são parte do
              pedido, e a miniatura de uma imagem colada precisa aparecer aqui,
              logo abaixo do campo, não dentro de um bloco fechado. */}
          <div className="mission-setup__express-attachments">
            <MissionAttachmentPicker
              contextPaths={draft.contextPaths}
              disabled={draftEditingDisabled || busy}
              compact
              onContextPathsChange={onContextPathsChange}
            />
        </div>

        <div
          className="mission-setup__field mission-setup__workspace-field"
          role="group"
          aria-label="Projeto da criação"
        >
          <div className="mission-setup__project-line">
            <p className="mission-setup__project-name">
              <span>Projeto</span>
              <span aria-hidden="true">·</span>
              <strong
                id="express-workspace-name"
                title={workspace?.path}
                aria-describedby={
                  workspace ? 'express-workspace-path' : undefined
                }
              >
                {workspace?.name ?? 'Nenhum projeto escolhido'}
              </strong>
            </p>
            {workspace && (
              <span
                id="express-workspace-path"
                className="mission-setup__sr-only"
              >
                {workspace.path}
              </span>
            )}
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              data-launcher-action="workspace"
              onClick={onPickWorkspace}
              disabled={pickingWorkspace || busy}
              aria-describedby={
                draftEditingDisabled ? disabledReasonId : undefined
              }
            >
              {pickingWorkspace
                ? 'Escolhendo pasta…'
                : workspace
                  ? 'Trocar pasta'
                  : 'Escolher pasta'}
              <kbd className="launcher-action__shortcut" aria-hidden="true">
                {launcherShortcutHint('workspace')}
              </kbd>
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
          {needsWorkspace && !draftEditingDisabled && (
            <p className="mission-setup__hint">
              Escreva sua ideia à vontade — ao iniciar, você escolhe a pasta e
              o texto acompanha sem apagar o rascunho que já existir nela.
            </p>
          )}
        </div>

        <details
          id="express-delivery-details"
          ref={deliveryDetailsRef}
          className="mission-setup__disclosure mission-setup__express-options"
        >
          <summary>
              Definir quando está pronto{' '}
            <span className="mission-setup__option-action">Opcional</span>
          </summary>
          <div className="mission-setup__option-content">
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
                  // Enter num campo de uma linha enviaria o formulário e
                  // iniciaria o trabalho sem querer: iniciar é ⌘/Ctrl+Enter
                  // ou o botão.
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                    }
                  }}
              />
              <span
                id="express-acceptance-hint"
                className="mission-setup__hint"
              >
                  Opcional, mas é o que a equipe usa para conferir a entrega
                  antes de dizer que terminou.
              </span>
            </div>
          </div>
        </details>

        {draft.roster.length > 0 ? (
          <details
            id="express-team-options"
            className="mission-setup__disclosure mission-setup__express-options"
          >
            <summary>
              <span className="mission-setup__option-summary">
                <strong>Equipe da criação</strong>
                <span>
                  {teamSize} {teamSize === 1 ? 'agente' : 'agentes'} ·{' '}
                  {teamTools.join(' · ')}
                </span>
              </span>
              <span className="mission-setup__option-action">
                Personalizar equipe
              </span>
            </summary>
            <div className="mission-setup__option-content">
              <h2>Quem faz o quê</h2>
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
              <button
                type="button"
                className="mission-setup__button mission-setup__button--quiet"
                onClick={onAdvanced}
                disabled={busy}
              >
                Mais papéis e tamanho
              </button>
            </div>
          </details>
        ) : inventoryLoading ? (
          <p className="mission-setup__hint">
            Verificando as ferramentas de IA conectadas…
          </p>
        ) : null}

        {/* O caminho manual fica VISÍVEL, não atrás de disclosure: o operador
              tinha que sair para Terminais só para achar um terminal. Não é
              passo intermediário no caminho padrão — dá para ignorar e apertar
            "Iniciar criação" — mas esconder foi o que incomodou. */}
          <div className="mission-setup__express-support">
        <ExpressTerminalOptions />
        <FirstStepsGuide />
          </div>
        </div>
      </div>

      {/* Dock irmão da área rolável (mesma receita da Equipe e da Revisão, §15):
          a ação principal e tudo o que responde a ela (pré-requisito, resposta
          direta, erro) ficam juntos e sempre à vista. */}
      <div className="mission-setup__step-dock">
        {providerMissing || directAnswer || error || maestroIssue ? (
          <div className="mission-setup__dock-feedback">
        {/* A pendência específica abaixo já oferece a ação de conexão. */}
            {providerMissing ? (
          <div
                className="mission-setup__section-heading mission-setup__provider-notice"
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
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onConnectProvider}
              disabled={busy}
            >
              Conectar uma ferramenta de IA
            </button>
          </div>
        ) : null}

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

      {(error || maestroIssue) && (
        <div
          id={error ? undefined : 'express-maestro-login'}
          className="mission-setup__error-summary"
          role="alert"
          aria-live="polite"
          aria-atomic="true"
        >
          {error ?? maestroIssue}
          {maestroIssue && (
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onConnectProvider}
              disabled={busy}
            >
              Conectar ferramenta da equipe
            </button>
          )}
        </div>
      )}
          </div>
        ) : null}

        <footer className="mission-setup__step-actions">
          <p className="mission-setup__dock-note">{dockNote}</p>
          <div className="mission-setup__dock-actions">
            <span className="mission-setup__dock-shortcut" aria-hidden="true">
              <kbd className="launcher-action__shortcut">{submitShortcut}</kbd>
              iniciar
            </span>
        <button
          type="submit"
          className="mission-setup__button mission-setup__button--primary mission-setup__button--start"
          disabled={busy || startBlocked}
              aria-keyshortcuts="Control+Enter Meta+Enter"
          aria-describedby={
            startBlocked && !error ? 'express-maestro-login' : undefined
          }
        >
          {busy
            ? 'Iniciando criação…'
            : needsWorkspace
                  ? 'Escolher pasta para iniciar'
              : 'Iniciar criação'}
        </button>
          </div>
      </footer>
        <span className="mission-setup__sr-only" role="status">
          {busy ? 'Preparando a missão. Aguarde.' : ''}
        </span>
      </div>
    </form>
  );
}
