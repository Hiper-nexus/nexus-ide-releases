import { useEffect, useMemo, useState } from 'react';
import type { AdapterInfo } from '../../shared/types';
import type {
  Mission,
  Squad,
  SquadAgent,
} from '../../shared/orch-types';
import type { RichModelMetadataView } from '../../shared/model-metadata-types';
import type { MissionLane } from '../../shared/mission-intent';
import { classifyStandardMissionTopology } from '../../shared/mission-topology';
import {
  buildRosterCostPreview,
  forecastMissionWaves,
  missionReviewP0P3Status,
  modelMetadataKey,
} from '../lib/mission-plan-preview';

interface MissionWizardPlanReviewProps {
  mission: Mission;
  squad: Squad;
  roster: SquadAgent[];
  adapters: AdapterInfo[];
  error: string | null;
  spawning: boolean;
  onBack(): void;
  onCancel(): void;
  onStart(): void;
}

type MetadataState = Record<
  string,
  RichModelMetadataView | null | undefined
>;

function laneLabel(lane: MissionLane | undefined): string {
  switch (lane) {
    case 'consult':
      return 'só pesquisar (não muda nada)';
    case 'plan':
      return 'só planejar (apenas o plano)';
    case 'ops':
      return 'só infra (não edita código)';
    default:
      return 'sem restrições';
  }
}

export function MissionWizardPlanReview({
  mission,
  squad,
  roster,
  adapters,
  error,
  spawning,
  onBack,
  onCancel,
  onStart,
}: MissionWizardPlanReviewProps) {
  const contract = mission.intentContract;
  const targets = useMemo(
    () =>
      roster.flatMap((agent) => {
        const adapter = adapters.find((entry) => entry.id === agent.cli);
        const modelId = agent.model?.trim() || adapter?.models.default;
        return modelId
          ? [
              {
                adapterId: agent.cli,
                modelId,
                key: modelMetadataKey(agent.cli, modelId),
              },
            ]
          : [];
      }),
    [roster, adapters],
  );
  const [metadataByKey, setMetadataByKey] = useState<MetadataState>({});

  useEffect(() => {
    let cancelled = false;
    const unique = [
      ...new Map(targets.map((target) => [target.key, target])).values(),
    ];
    if (unique.length === 0) {
      return () => {
        cancelled = true;
      };
    }
    const bridge = window.nexus?.model;
    if (!bridge) {
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(
      unique.map(async (target) => {
        try {
          const metadata = await bridge.richMetadata(
            target.adapterId,
            target.modelId,
          );
          return [target.key, metadata] as const;
        } catch {
          return [target.key, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setMetadataByKey(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [targets]);

  if (!contract) {
    return (
      <div className="wizard__section">
        <h2
          className="wizard__label"
          data-wizard-plan-review-heading
          tabIndex={-1}
        >
          REVISÃO DA MISSÃO
        </h2>
        <p className="wizard__error" role="alert" aria-live="assertive">
          O Nexus não recebeu um contrato de intenção válido para revisar.
          Volte ao objetivo e tente novamente; nenhum agente foi despachado.
        </p>
        <div className="wizard__actions">
          <button className="wizard__btn wizard__btn--ghost" onClick={onBack}>
            ‹ Editar objetivo
          </button>
          <button className="wizard__btn wizard__btn--ghost" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  const waves = forecastMissionWaves({
    lane: contract.lane,
    maxWorkers: contract.budgets.maxWorkers,
    goal: contract.promotedPlan ? '' : contract.goal,
  });
  const isTeamReadOnlyFanout =
    !contract.promotedPlan &&
    (contract.lane ?? 'standard') === 'standard' &&
    classifyStandardMissionTopology(contract.goal) ===
      'team-read-only-fanout';
  const costs = buildRosterCostPreview({
    roster,
    adapters,
    metadataByKey: window.nexus?.model
      ? metadataByKey
      : Object.fromEntries(targets.map((target) => [target.key, null])),
  });
  const reviewStatus = missionReviewP0P3Status(squad);

  return (
    <div className="wizard__section">
      <h2
        className="wizard__label"
        data-wizard-plan-review-heading
        tabIndex={-1}
      >
        REVISÃO DA MISSÃO
      </h2>
      <p className="wizard__mode-desc">
        <strong>Objetivo:</strong> {contract.goal || mission.description}
      </p>
      <p className="wizard__mode-desc">
        <strong>Modo:</strong>{' '}
        {isTeamReadOnlyFanout
          ? 'rodada da equipe · somente leitura'
          : laneLabel(contract.lane)}
        {' · '}
        <strong>Risco:</strong> {contract.risk}
        {' · '}
        <strong>Agentes em paralelo:</strong> {contract.budgets.maxWorkers}
      </p>

      <div className="wizard__plan-grid">
        <section className="wizard__plan-card">
          <h3 className="wizard__label">CRITÉRIOS DE ACEITE</h3>
          {contract.acceptanceCriteria.length > 0 ? (
            <ul className="wizard__mode-desc">
              {contract.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          ) : (
            <p className="wizard__hint-sm">
              Nenhum critério adicional foi identificado; o Nexus ainda exige
              entrega registrada e prova compatível com o objetivo.
            </p>
          )}
        </section>

        <section className="wizard__plan-card">
          <h3 className="wizard__label">ONDAS PREVISTAS</h3>
          <p className="wizard__hint-sm">
            {isTeamReadOnlyFanout
              ? 'O Main sela uma tarefa raiz por especialista e inicia a equipe na mesma onda.'
              : 'Estimativa antes do plano de tarefas controlado pelo Nexus; dependências reais podem executar estas etapas em sequência ou dividi-las.'}
          </p>
          <ol className="wizard__mode-desc">
            {waves.map((wave) => (
              <li key={wave.title}>
                <strong>{wave.title}:</strong> {wave.detail}
              </li>
            ))}
          </ol>
        </section>

        <section className="wizard__plan-card">
          <h3 className="wizard__label">CUSTO ESTIMADO DO TIME</h3>
          <ul className="wizard__roster">
            {costs.lines.map((line) => (
              <li
                key={line.agentId}
                className="wizard__roster-item wizard__plan-cost-row"
              >
                <strong>{line.agentName}</strong> ({line.roleLabel}) ·{' '}
                {line.adapterId}
                {line.modelId
                  ? ` / ${line.modelId}`
                  : ' / modelo não definido'}
                <br />
                {line.rateLabel} · {line.estimateLabel}
              </li>
            ))}
          </ul>
          <p className="wizard__mode-desc">
            <strong>{costs.totalLabel}</strong>
          </p>
          <p className="wizard__hint-sm">{costs.caveat}</p>
        </section>

        <section className="wizard__plan-card">
          <h3 className="wizard__label">
            {isTeamReadOnlyFanout
              ? 'ENTREGAS DA EQUIPE'
              : 'REVISÃO TÉCNICA AUTOMÁTICA AO FINAL'}
          </h3>
          <p className="wizard__mode-desc">
            {isTeamReadOnlyFanout ? (
              <>
                <strong>Handoffs físicos obrigatórios.</strong> O Nexus só
                encerra depois de receber e consumir a resposta de cada
                especialista.
              </>
            ) : (
              <>
                <strong>{reviewStatus.label}</strong> {reviewStatus.detail}
              </>
            )}
          </p>
        </section>
      </div>

      {mission.intentState === 'awaiting_approval' && (
        <p className="wizard__mode-desc">
          Esta missão inclui uma ação sensível: revise o plano antes de
          iniciar o time.
        </p>
      )}
      <p className="wizard__mode-desc">
        {isTeamReadOnlyFanout
          ? 'Depois de começar, todos os especialistas respondem em paralelo e o Maestro consolida a rodada. O Nexus só volta a você para autenticação, decisão real ou autorização sensível.'
          : 'Depois de começar, o Nexus conduz a implementação, a revisão independente e a validação final. Ele só volta a você para uma decisão real, uma autorização sensível ou um bloqueio comprovado.'}
      </p>
      {error && (
        <p className="wizard__error" role="alert" aria-live="assertive">
          {error}
        </p>
      )}
      <p className="wizard__approval-note">
        Nenhum agente será iniciado neste clique. A próxima janela é a única
        autorização para começar a missão.
      </p>
      <div className="wizard__actions">
        <button className="wizard__btn wizard__btn--ghost" onClick={onBack}>
          ‹ Editar objetivo
        </button>
        <div className="wizard__actions-right">
          <button className="wizard__btn wizard__btn--ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="wizard__btn wizard__btn--primary"
            disabled={spawning}
            onClick={onStart}
          >
            {spawning
              ? 'Abrindo aprovação…'
              : 'Enviar para aprovação'}
          </button>
        </div>
      </div>
    </div>
  );
}
