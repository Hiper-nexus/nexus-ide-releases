import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  MissionAgentSnapshot, MissionEngineCommand, MissionSnapshot, MissionUnit,
} from '../../../shared/mission-engine-contract';
import type { MissionEvent } from '../../../shared/mission-events';
import { useMissionInspectorStore, type InspectorTab } from '../../state/mission-inspector-store';
import { projectChangedFiles } from '../../lib/mission-changed-files';
import { useFilesStore } from '../../state/files-store';
import { useOrchStore } from '../../state/orch-store';
import { useContextualPanelNavStore } from '../../state/contextual-panel-nav-store';
import { DirectionComposer } from './DirectionComposer';
import { AgentActivityTimeline } from './AgentActivityTimeline';

interface MissionInspectorProps {
  readonly snapshot: MissionSnapshot;
  readonly events: readonly MissionEvent[];
  readonly onCommand: (command: MissionEngineCommand) => Promise<MissionSnapshot>;
  readonly question: ReactNode;
  readonly onOpenTerminals?: () => void;
}

const TABS = [
  { key: 'agent', label: 'Agente' },
  { key: 'plan', label: 'Plano' },
  { key: 'chat', label: 'Conversa' },
  { key: 'activity', label: 'Atividade' },
  { key: 'team', label: 'Equipe' },
  { key: 'result', label: 'Resultado' },
] as const satisfies readonly { key: InspectorTab; label: string }[];

const AGENT_STATE_LABELS: Readonly<Record<MissionAgentSnapshot['state'], string>> = {
  queued: 'Na fila',
  working: 'Trabalhando',
  waiting: 'Aguardando',
  blocked: 'Bloqueado',
  done: 'Concluído',
  failed: 'Falhou',
  stopped: 'Interrompido',
};

const UNIT_STATUS_LABELS: Readonly<Record<MissionUnit['status'], string>> = {
  pending: 'Pendente',
  running: 'Em andamento',
  blocked: 'Bloqueada',
  done: 'Concluída',
  failed: 'Falhou',
};

const RESULT_OUTCOME_LABELS: Readonly<Record<NonNullable<MissionSnapshot['result']>['outcome'], string>> = {
  success: 'Concluído com sucesso',
  partial: 'Resultado parcial',
  failed: 'Falhou',
};

const BASIC_ACTIVITY_LABELS: Readonly<Partial<Record<MissionEvent['type'], string>>> = {
  'mission.created': 'Missão criada',
  'mission.status_changed': 'Status atualizado',
  'mission.intent_armed': 'Objetivo armado',
  'mission.run_started': 'Execução iniciada',
  'mission.run_finished': 'Execução encerrada',
  'agent.spawned': 'Agente iniciou',
  'agent.finished': 'Agente terminou',
  'agent.needs_input': 'Agente pediu decisão',
  'agent.reaped': 'Agente encerrado',
  'tool.invoked': 'Ferramenta acionada',
  'tool.completed': 'Ferramenta concluída',
  'tool.denied': 'Ferramenta bloqueada',
  'handoff.submitted': 'Entrega enviada',
  'handoff.acked': 'Entrega reconhecida',
  'budget.reserved': 'Orçamento reservado',
  'budget.released': 'Orçamento liberado',
  'driver.tick': 'Controlador atualizou',
  'driver.error': 'Controlador relatou uma falha',
  'ui.projection': 'Atividade atualizada',
  custom: 'Evento personalizado registrado',
};

const OPERATOR_DIRECTION_KEY_RE = /^operator_direction:[a-f0-9]{64}$/u;
const UNSAFE_LABEL_CONTROL_RE =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function CanonicalField({
  label,
  children,
}: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mission-inspector__field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CanonicalStringList({
  values,
  empty,
}: { readonly values: readonly string[]; readonly empty: string }) {
  if (values.length === 0) {
    return <span className="mission-inspector__empty-value">{empty}</span>;
  }
  return (
    <ul className="mission-inspector__value-list">
      {values.map((value, index) => (
        <li key={`${value}-${index}`}>
          <code>{value}</code>
        </li>
      ))}
    </ul>
  );
}

function CapabilityList({
  values,
  empty,
}: {
  readonly values: readonly string[] | null | undefined;
  readonly empty: string;
}) {
  if (values === null || values === undefined) {
    return <span className="mission-inspector__empty-value">Sem restrição declarada.</span>;
  }
  return <CanonicalStringList values={values} empty={empty} />;
}

function PlanDocumentAuthority({ value }: { readonly value?: boolean }) {
  if (value === true) return <>Responsável pelos documentos do plano.</>;
  if (value === false) {
    return <>Não é responsável pelos documentos do plano.</>;
  }
  return <>Autoridade sobre documentos do plano não declarada.</>;
}

function AgentCanonicalDetails({
  agent,
  units,
}: {
  readonly agent: MissionAgentSnapshot;
  readonly units: readonly MissionUnit[];
}) {
  const currentUnit = agent.currentUnitId
    ? units.find((unit) => unit.id === agent.currentUnitId) ?? null
    : null;

  return (
    <dl className="mission-inspector__details">
      <CanonicalField label="Identificador do agente">
        <code>{agent.id}</code>
      </CanonicalField>
      <CanonicalField label="Categoria">
        <code>{agent.category}</code>
      </CanonicalField>
      <CanonicalField label="Estado">
        {AGENT_STATE_LABELS[agent.state]} (<code>{agent.state}</code>)
      </CanonicalField>
      <CanonicalField label="CLI">
        <code>{agent.cli}</code>
      </CanonicalField>
      <CanonicalField label="Provider">
        {agent.providerId ? <code>{agent.providerId}</code> : 'Não informado.'}
      </CanonicalField>
      <CanonicalField label="Modelo">
        {agent.model ? <code>{agent.model}</code> : 'Não informado.'}
      </CanonicalField>
      <CanonicalField label="Esforço">
        {agent.effort ? <code>{agent.effort}</code> : 'Não informado.'}
      </CanonicalField>
      <CanonicalField label="Persona">
        {agent.persona ?? 'Não informada.'}
      </CanonicalField>
      <CanonicalField label="Pane">
        {agent.paneId ? <code>{agent.paneId}</code> : 'Nenhum pane vinculado.'}
      </CanonicalField>
      <CanonicalField label="Unidade atual">
        {agent.currentUnitId ? (
          <>
            <code>{agent.currentUnitId}</code>
            {currentUnit ? (
              <> · {currentUnit.title}</>
            ) : (
              <> · Unidade referenciada não encontrada no snapshot.</>
            )}
          </>
        ) : (
          'Nenhuma unidade atual vinculada.'
        )}
      </CanonicalField>
      <CanonicalField label="Detalhe">
        {agent.detail ?? 'Nenhum detalhe informado.'}
      </CanonicalField>
      <CanonicalField label="Instruções">
        {agent.instructions ?? 'Nenhuma instrução específica informada.'}
      </CanonicalField>
      <CanonicalField label="Documentos do plano">
        <PlanDocumentAuthority value={agent.ownsPlanDocs} />
      </CanonicalField>
      <CanonicalField label="Skills autorizadas">
        <CapabilityList
          values={agent.allowedSkills}
          empty="Nenhuma skill autorizada."
        />
      </CanonicalField>
      <CanonicalField label="Ferramentas autorizadas">
        <CapabilityList
          values={agent.allowedTools}
          empty="Nenhuma ferramenta autorizada."
        />
      </CanonicalField>
    </dl>
  );
}

function AgentProjection({
  snapshot,
  selectedAgentId,
}: {
  readonly snapshot: MissionSnapshot;
  readonly selectedAgentId: string | null;
}) {
  if (snapshot.agents.length === 0) {
    return (
      <p className="mission-inspector__empty" role="status">
        Nenhum agente canônico está disponível nesta missão.
      </p>
    );
  }

  const selectedAgent =
    snapshot.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  if (!selectedAgent) {
    return (
      <p className="mission-inspector__empty" role="status">
        O agente selecionado não está presente no snapshot canônico.
      </p>
    );
  }

  return (
    <article className="mission-inspector__agent">
      <header className="mission-inspector__projection-header">
        <h2>{selectedAgent.agentName}</h2>
      </header>
      <AgentCanonicalDetails agent={selectedAgent} units={snapshot.units} />
    </article>
  );
}

/**
 * O plano que o agente escreveu, em prosa — não a projeção de unidades.
 *
 * `intentContract.promotedPlan.summary` é o PRD/plano físico selado pelo
 * motor, com SHA. Tinha 25 referências no main e ZERO no renderer: o produto
 * produzia o escopo e nunca mostrava. Dos cinco elos do princípio 7 (ideia →
 * escopo → aprovação → progresso → entrega), "escopo" não tinha superfície.
 */
function SealedPlan({ missionId }: { readonly missionId: string }) {
  const plan = useOrchStore(
    (state) =>
      state.missions.find((mission) => mission.id === missionId)?.intentContract
        ?.promotedPlan,
  );
  if (!plan?.summary?.trim()) return null;

  return (
    <section
      className="mission-inspector__sealed-plan"
      aria-label="O que vamos construir"
    >
      <h2>O que vamos construir</h2>
      <p className="mission-inspector__sealed-plan-body">{plan.summary}</p>
      <details className="mission-inspector__technical">
        <summary>Detalhes técnicos</summary>
        <dl className="mission-inspector__details">
          <CanonicalField label="Selo do plano">
            <code>{plan.summarySha256.slice(0, 12)}</code>
          </CanonicalField>
          <CanonicalField label="Artefatos anexados">
            {String(plan.artifacts.length)}
          </CanonicalField>
        </dl>
      </details>
    </section>
  );
}

/**
 * Por que não dá para orientar agora — e o que fazer em vez disso.
 *
 * "Esta missão não aceita novas orientações no estado atual" nomeava a
 * recusa e escondia a saída: a pessoa ficava sem saber se esperava, clicava
 * em algo, ou tinha perdido o trabalho.
 */
export function directionUnavailableReason(
  state: string | null | undefined,
): string {
  switch (state) {
    case 'completed':
      return 'A entrega está aguardando a sua revisão. Digite no Maestro para continuar a conversa, ou use "Pedir um ajuste" no topo para reabrir o quadro.';
    case 'failed':
      return 'A missão falhou. Use "Tentar de novo" no topo para reabrir a coordenação; o histórico fica.';
    case 'blocked_user':
      return 'A missão está esperando a sua resposta — responda a pergunta acima para ela seguir.';
    case 'starting':
    case 'draft':
    case 'review_ready':
      return 'A missão ainda está começando. Assim que a equipe abrir, você poderá orientar por aqui.';
    case 'stopping':
      return 'A missão está encerrando. Aguarde o fim para decidir o próximo passo.';
    default:
      return 'Não dá para orientar neste estado. Veja a aba Atividade para entender o que está acontecendo.';
  }
}

function PlanProjection({ snapshot }: { readonly snapshot: MissionSnapshot }) {
  if (snapshot.units.length === 0) {
    return (
      <>
        <SealedPlan missionId={snapshot.id} />
        <p className="mission-inspector__empty" role="status">
          Nenhuma unidade de plano foi persistida para esta missão.
        </p>
      </>
    );
  }

  return (
    <>
    <SealedPlan missionId={snapshot.id} />
    <ol className="mission-inspector__plan-list">
      {snapshot.units.map((unit) => {
        const owner = unit.agentId
          ? snapshot.agents.find((agent) => agent.id === unit.agentId) ?? null
          : null;

        return (
          <li key={unit.id} className="mission-inspector__plan-item">
            <article>
              <header className="mission-inspector__projection-header">
                <h2>{unit.title}</h2>
                <code>{unit.id}</code>
              </header>
              <dl className="mission-inspector__details">
                <CanonicalField label="Estado">
                  {UNIT_STATUS_LABELS[unit.status]} (<code>{unit.status}</code>)
                </CanonicalField>
                <CanonicalField label="Responsável">
                  {unit.agentId ? (
                    <>
                      {owner?.agentName ?? 'Agente não encontrado no snapshot'} ·{' '}
                      <code>{unit.agentId}</code>
                    </>
                  ) : (
                    'Sem responsável vinculado.'
                  )}
                </CanonicalField>
                <CanonicalField label="Dependências">
                  <CanonicalStringList
                    values={unit.dependsOn}
                    empty="Nenhuma dependência."
                  />
                </CanonicalField>
                <CanonicalField label="Evidências">
                  <CanonicalStringList
                    values={unit.evidenceIds}
                    empty="Nenhuma evidência vinculada."
                  />
                </CanonicalField>
              </dl>
            </article>
          </li>
        );
      })}
    </ol>
    </>
  );
}

interface OperatorDirection {
  readonly eventId: string;
  readonly sequence: number;
  readonly targetAgentId: string | null;
  readonly text: string;
}

function acceptedOperatorDirections(
  events: readonly MissionEvent[],
  missionId: string,
): OperatorDirection[] {
  const directions: OperatorDirection[] = [];

  for (const event of events) {
    if (
      event.missionId !== missionId ||
      event.type !== 'custom' ||
      event.origin !== 'main' ||
      event.runId !== 'operator-direction' ||
      !OPERATOR_DIRECTION_KEY_RE.test(event.idempotencyKey)
    ) {
      continue;
    }

    const { kind, targetAgentId, text } = event.payload;
    if (
      kind !== 'operator_direction' ||
      (targetAgentId !== null &&
        (typeof targetAgentId !== 'string' || targetAgentId.length === 0)) ||
      typeof text !== 'string' ||
      text.trim().length === 0
    ) {
      continue;
    }

    directions.push({
      eventId: event.id,
      sequence: event.sequence,
      targetAgentId,
      text,
    });
  }

  return directions.sort((left, right) => left.sequence - right.sequence);
}

function directionTargetLabel(
  targetAgentId: string | null,
  agents: readonly MissionAgentSnapshot[],
): ReactNode {
  if (targetAgentId === null) return <code>@todos</code>;
  const agent = agents.find((candidate) => candidate.id === targetAgentId);
  return (
    <>
      {agent ? `@${agent.agentName}` : 'Agente não encontrado'} ·{' '}
      <code>{targetAgentId}</code>
    </>
  );
}

function ConversationProjection({
  snapshot,
  events,
  question,
  onCommand,
}: MissionInspectorProps) {
  const directions = acceptedOperatorDirections(events, snapshot.id);
  const canDirect = snapshot.allowedActions.includes('direct');

  return (
    <div className="mission-inspector__conversation">
      <section aria-label="Orientações do operador">
        <h2>Orientações do operador</h2>
        {directions.length > 0 ? (
          <ol className="mission-inspector__direction-list">
            {directions.map((direction) => (
              <li key={direction.eventId}>
                <article className="mission-inspector__direction">
                  <p>{direction.text}</p>
                  <p className="mission-inspector__direction-target">
                    Destino:{' '}
                    {directionTargetLabel(
                      direction.targetAgentId,
                      snapshot.agents,
                    )}
                  </p>
                </article>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mission-inspector__empty" role="status">
            Nenhuma orientação aceita ainda.
          </p>
        )}
      </section>

      {question === null || question === undefined ? (
        <p className="mission-inspector__empty" role="status">
          Nenhuma pergunta ativa nesta missão.
        </p>
      ) : (
        <div className="mission-inspector__question-slot">{question}</div>
      )}

      {canDirect ? (
        <DirectionComposer
          missionId={snapshot.id}
          agents={snapshot.agents}
          onCommand={onCommand}
        />
      ) : (
        <p className="mission-inspector__empty" role="status">
          {directionUnavailableReason(snapshot.state)}
        </p>
      )}
    </div>
  );
}

function isSafeNullableLabel(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 128 &&
      !UNSAFE_LABEL_CONTROL_RE.test(value))
  );
}

function observerActivityLabel(event: MissionEvent): string | null {
  if (!event.type.startsWith('observer.')) return null;
  const rawObserver = event.payload.observer;
  if (
    rawObserver === null ||
    typeof rawObserver !== 'object' ||
    Array.isArray(rawObserver)
  ) {
    return null;
  }
  const observer = rawObserver as Record<
    'adapterId' | 'kind' | 'ok' | 'outcome' | 'reason' | 'silentForMs' | 'status' | 'toolName' | 'turnSequence',
    unknown
  >;

  switch (event.type) {
    case 'observer.turn_started':
      return typeof observer.turnSequence === 'number' &&
        Number.isSafeInteger(observer.turnSequence) &&
        observer.turnSequence > 0
        ? `Etapa ${observer.turnSequence} iniciada`
        : null;
    case 'observer.turn_ended':
      return observer.outcome === 'completed'
        ? 'Etapa concluída'
        : observer.outcome === 'error'
          ? 'A etapa terminou com erro'
          : null;
    case 'observer.tool_call':
      if (!isSafeNullableLabel(observer.toolName)) return null;
      return observer.toolName
        ? `Ferramenta ${observer.toolName} chamada`
        : 'Ferramenta não identificada chamada';
    case 'observer.tool_result':
      if (
        !isSafeNullableLabel(observer.toolName) ||
        typeof observer.ok !== 'boolean'
      ) {
        return null;
      }
      return `${observer.toolName ?? 'Ferramenta'} ${
        observer.ok ? 'concluída' : 'falhou'
      }`;
    case 'observer.status_changed':
      if (observer.status === 'working') return 'Estado do agente: Trabalhando';
      if (observer.status === 'completed') return 'Estado do agente: Concluído';
      if (observer.status === 'awaiting-input') return 'Estado do agente: Aguardando você';
      if (observer.status === 'idle') return 'Estado do agente: Em espera';
      if (observer.status === 'error') return 'Estado do agente: Erro';
      return null;
    case 'observer.session_spawned':
      if (!isSafeNullableLabel(observer.adapterId)) return null;
      return observer.adapterId
        ? `Sessão ${observer.adapterId} iniciada`
        : 'Sessão de agente iniciada';
    case 'observer.session_exited':
      return [
        'pty-exit',
        'acp-shutdown',
        'acp-timeout',
        'acp-cancel',
        'acp-error',
        'acp-peer-exited',
      ].includes(String(observer.reason))
        ? 'Sessão encerrada'
        : null;
    case 'observer.stall_suspected': {
      const silentForMs = observer.silentForMs;
      if (
        typeof silentForMs !== 'number' ||
        !Number.isFinite(silentForMs) ||
        silentForMs < 0
      ) {
        return null;
      }
      const minutes = Math.max(0, Math.round(silentForMs / 60_000));
      return `Possível travamento: ${minutes} min sem atividade`;
    }
    case 'observer.provider_error':
      if (observer.kind === 'quota') return 'Cota esgotada; rota alternativa acionada';
      if (observer.kind === 'rate-limit') return 'Limite de uso; rota alternativa acionada';
      if (observer.kind === 'auth') return 'Credencial inválida; rota alternativa acionada';
      if (observer.kind === 'transient') {
        return 'Indisponibilidade temporária; rota alternativa acionada';
      }
      return null;
    default:
      return null;
  }
}

interface ActivityItem {
  readonly eventId: string;
  readonly sequence: number;
  readonly label: string;
}

function normalizedActivity(
  events: readonly MissionEvent[],
  missionId: string,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const event of events) {
    if (event.missionId !== missionId) continue;
    const label = event.type.startsWith('observer.')
      ? observerActivityLabel(event)
      : BASIC_ACTIVITY_LABELS[event.type] ?? 'Evento da missão registrado';
    if (!label) continue;
    items.push({
      eventId: event.id,
      sequence: event.sequence,
      label,
    });
  }

  return items.sort((left, right) => left.sequence - right.sequence);
}

function ActivityProjection({
  snapshot,
  events,
}: {
  readonly snapshot: MissionSnapshot;
  readonly events: readonly MissionEvent[];
}) {
  const [viewMode, setViewMode] = useState<'timeline' | 'canonical'>('canonical');
  const items = normalizedActivity(events, snapshot.id);

  if (items.length === 0) {
    return (
      <p className="mission-inspector__empty" role="status">
        Nenhuma atividade canônica segura foi registrada ainda.
      </p>
    );
  }

  return (
    <div className="mission-inspector__activity-wrap">
      <div className="mission-inspector__activity-view-switcher" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <button
          type="button"
          className="product-pane__btn product-pane__btn--ghost"
          style={{ fontSize: 10, padding: '2px 8px' }}
          onClick={() => setViewMode((m) => (m === 'timeline' ? 'canonical' : 'timeline'))}
        >
          {viewMode === 'timeline' ? 'Lista simples' : 'Timeline detalhada'}
        </button>
      </div>
      {viewMode === 'timeline' ? (
        <AgentActivityTimeline events={events} missionId={snapshot.id} />
      ) : (
        <ol className="mission-inspector__activity-list">
          {items.map((item) => (
            <li key={item.eventId}>
              <span className="mission-inspector__sequence">#{item.sequence}</span>{' '}
              <span>{item.label}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TeamProjection({ snapshot }: { readonly snapshot: MissionSnapshot }) {
  if (snapshot.agents.length === 0) {
    return (
      <p className="mission-inspector__empty" role="status">
        Nenhum agente foi persistido na equipe desta missão.
      </p>
    );
  }

  return (
    <ul className="mission-inspector__team-list">
      {snapshot.agents.map((agent) => (
        <li key={agent.id}>
          <article className="mission-inspector__team-member">
            <header className="mission-inspector__projection-header">
              <h2>{agent.agentName}</h2>
            </header>
            <AgentCanonicalDetails agent={agent} units={snapshot.units} />
          </article>
        </li>
      ))}
    </ul>
  );
}

function MissingResult({ snapshot }: { readonly snapshot: MissionSnapshot }) {
  const message =
    snapshot.state === 'failed'
      ? 'A missão falhou sem resultado canônico persistido.'
      : snapshot.state === 'completed'
        ? 'A missão foi concluída, mas o resultado canônico não foi persistido.'
        : 'O resultado canônico ainda não foi persistido.';

  return (
    <div className="mission-inspector__missing-result" role="status">
      <p>{message}</p>
      {snapshot.stateReason && (
        <dl className="mission-inspector__details">
          <CanonicalField label="Código do estado">
            <code>{snapshot.stateReason.code}</code>
          </CanonicalField>
          <CanonicalField label="Motivo">{snapshot.stateReason.label}</CanonicalField>
          <CanonicalField label="Detalhe">
            {snapshot.stateReason.detail ?? 'Nenhum detalhe informado.'}
          </CanonicalField>
        </dl>
      )}
    </div>
  );
}

function ResultProjection({ snapshot }: { readonly snapshot: MissionSnapshot }) {
  const { result } = snapshot;
  if (!result) return <MissingResult snapshot={snapshot} />;

  return (
    <article className="mission-inspector__result">
      <header className="mission-inspector__projection-header">
        <h2>{RESULT_OUTCOME_LABELS[result.outcome]}</h2>
      </header>
      <p className="mission-inspector__result-summary">{result.summary}</p>
      <ChangedFiles artifactRefs={result.artifactRefs} />
      <details className="mission-inspector__technical">
        <summary>Detalhes técnicos</summary>
        <section aria-label="Evidências do resultado">
          <h3>Evidências</h3>
          <CanonicalStringList
            values={result.evidenceIds}
            empty="Nenhuma evidência foi persistida no resultado."
          />
        </section>
        <section aria-label="Artefatos do resultado">
          <h3>Artefatos</h3>
          <CanonicalStringList
            values={result.artifactRefs}
            empty="Nenhum artefato foi persistido no resultado."
          />
        </section>
      </details>
    </article>
  );
}

/**
 * "O que mudou" — a única resposta que quem pediu a missão procura na tela
 * final. Antes a aba mostrava só listas de caminhos em monoespaçada, sem
 * link e sem dizer o que cada arquivo é.
 */
function ChangedFiles({
  artifactRefs,
}: {
  readonly artifactRefs: readonly string[];
}) {
  const projection = useMemo(
    () => projectChangedFiles(artifactRefs),
    [artifactRefs],
  );

  if (projection.files.length === 0) {
    return (
      <section
        className="mission-inspector__changed"
        aria-label="O que mudou no projeto"
      >
        <h3>O que mudou</h3>
        <p className="mission-inspector__changed-empty">
          Nenhum arquivo do projeto foi alterado nesta missão.
        </p>
      </section>
    );
  }

  return (
    <section
      className="mission-inspector__changed"
      aria-label="O que mudou no projeto"
    >
      <h3>O que mudou</h3>
      <ul className="mission-inspector__changed-list">
        {projection.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="mission-inspector__changed-file"
              aria-label={`Abrir ${file.path}`}
              onClick={() => {
                void useFilesStore.getState().selectFile(file.path);
                useContextualPanelNavStore
                  .getState()
                  .openTab('editor', { focus: true });
              }}
            >
              <span className="mission-inspector__changed-role">
                {file.role}
              </span>
              <span className="mission-inspector__changed-path">
                {file.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InspectorPanelContent({
  tab,
  selectedAgentId,
  snapshot,
  events,
  onCommand,
  question,
}: MissionInspectorProps & {
  readonly tab: InspectorTab;
  readonly selectedAgentId: string | null;
}) {
  switch (tab) {
    case 'agent':
      return <AgentProjection snapshot={snapshot} selectedAgentId={selectedAgentId} />;
    case 'plan':
      return <PlanProjection snapshot={snapshot} />;
    case 'chat':
      return (
        <ConversationProjection
          snapshot={snapshot}
          events={events}
          onCommand={onCommand}
          question={question}
        />
      );
    case 'activity':
      return <ActivityProjection snapshot={snapshot} events={events} />;
    case 'team':
      return <TeamProjection snapshot={snapshot} />;
    case 'result':
      return <ResultProjection snapshot={snapshot} />;
  }
}

export function MissionInspector({
  snapshot,
  events,
  onCommand,
  question,
  onOpenTerminals,
}: MissionInspectorProps) {
  const activeTab = useMissionInspectorStore((state) => state.tab);
  const selectedAgentId = useMissionInspectorStore(
    (state) => state.selectedAgentId,
  );
  const bindSnapshot = useMissionInspectorStore((state) => state.bindSnapshot);
  const selectTab = useMissionInspectorStore((state) => state.selectTab);
  const tabIdPrefix = `mission-inspector-tab-${useId()}`;
  const panelIdPrefix = `mission-inspector-panel-${useId()}`;

  useEffect(() => {
    bindSnapshot(snapshot);
  }, [bindSnapshot, snapshot]);

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const nextIndex =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex];
    selectTab(nextTab.key);
    event.currentTarget.ownerDocument
      .getElementById(`${tabIdPrefix}-${nextTab.key}`)
      ?.focus();
  };

  return (
    <aside className="mission-inspector" aria-label="Inspetor da missão">
      <div className="mission-inspector__chrome">
      <div
        className="mission-inspector__tabs"
        role="tablist"
        aria-label="Detalhes da missão"
      >
        {TABS.map((tab, index) => {
          const selected = activeTab === tab.key;
          const tabId = `${tabIdPrefix}-${tab.key}`;
          const panelId = `${panelIdPrefix}-${tab.key}`;
          return (
            <button
              key={tab.key}
              id={tabId}
              type="button"
              role="tab"
              className="mission-inspector__tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.key)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {onOpenTerminals ? (
        <button
          type="button"
          className="mission-inspector__open-terminals"
          data-testid="mission-inspector-terminals"
          onClick={onOpenTerminals}
        >
          Terminais
        </button>
      ) : null}
      </div>

      {TABS.map((tab) => {
        const selected = activeTab === tab.key;
        return (
          <div
            key={tab.key}
            id={`${panelIdPrefix}-${tab.key}`}
            className="mission-inspector__panel"
            role="tabpanel"
            aria-labelledby={`${tabIdPrefix}-${tab.key}`}
            hidden={!selected}
            tabIndex={selected ? 0 : -1}
          >
            <InspectorPanelContent
              tab={tab.key}
              selectedAgentId={selectedAgentId}
              snapshot={snapshot}
              events={events}
              onCommand={onCommand}
              question={question}
            />
          </div>
        );
      })}
    </aside>
  );
}
