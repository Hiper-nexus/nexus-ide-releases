import { useEffect, useRef, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import type { MissionLane } from '../../../shared/mission-intent';
import { missionDeliveryRosterIssue } from '../../../shared/mission-engine-contract';
import {
  strictSquadAgentSchema,
  type SquadAgent,
} from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import type { OrchSettings } from '../../../shared/settings-types';
import { PET_STUDIO_SQUAD } from '../../../shared/pet-studio';
import type { AdapterInfo } from '../../../shared/types';
import {
  isAdapterModelAuthenticated,
  type MissionRuntimeReadiness,
} from '../../orch/mission-runtime-readiness';
import {
  isExactPetStudioEntryContext,
  type MissionSetupEntryContext,
} from '../../state/mission-setup-store';
import {
  buildCustomRosterAgent,
  MISSION_ROSTER_MAX_AGENTS,
  planRemoveRosterAgent,
  recommendMissionRosterRoles,
  type CustomizableWorkerCategory,
} from '../../orch/mission-roster-customize';
import {
  MissionSetupRosterRow,
  readyModelForAdapter,
} from './MissionSetupRosterRow';

export interface MissionTeamInventory {
  status: 'loading' | 'ready' | 'error';
  adapters: readonly AdapterInfo[];
  providers: readonly ProviderSettingsInfo[];
  accounts: readonly AccountInfo[];
  settings: OrchSettings;
  readiness: MissionRuntimeReadiness;
  error: string | null;
}

interface BuildRecommendedMissionRosterInput {
  readonly objective: string;
  readonly lane: MissionLane;
  readonly readiness: MissionRuntimeReadiness;
  readonly providers: readonly ProviderSettingsInfo[];
  readonly accounts: readonly AccountInfo[];
  readonly settings: OrchSettings;
}

interface TeamStepProps {
  roster: readonly SquadAgent[];
  lane: MissionLane;
  recommendationStale: boolean;
  revision: number;
  inventory: MissionTeamInventory;
  entryContext?: MissionSetupEntryContext | null;
  onRosterChange(roster: readonly SquadAgent[]): void;
  onBack(): void;
  onContinue(): void;
  onRetryInventory(): void;
  onRefreshRecommendation(): void;
}


function providerEffort(
  adapterId: string,
  providers: readonly ProviderSettingsInfo[],
): string | undefined {
  const provider = providers.find((item) => item.adapterId === adapterId);
  if (!provider?.effort) return undefined;
  return provider.efforts.length === 0 ||
    provider.efforts.includes(provider.effort)
    ? provider.effort
    : undefined;
}

/**
 * Tamanhos prontos de equipe. Total inclui a coordenação, então 4 = 1 coord +
 * 3 execuções. O teto real continua sendo `cores - 2` e o orçamento de panes
 * do agendador — o preset só compõe, nunca amplia permissão.
 */
const TEAM_PRESETS: ReadonlyArray<{ total: number; label: string }> = [
  { total: 3, label: 'Enxuta' },
  { total: 5, label: 'Padrão' },
  { total: 8, label: 'Força total' },
];

export function buildRecommendedMissionRoster({
  objective,
  lane,
  readiness,
  providers,
  accounts,
  settings,
}: BuildRecommendedMissionRosterInput): SquadAgent[] | null {
  const coordinators = [...readiness.verifiedMaestros].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const configuredCoordinator = coordinators.find(
    (adapter) => adapter.id === settings.defaultAdapterId,
  );
  const coordinator = configuredCoordinator ?? coordinators[0] ?? null;
  const workers = readiness.qualifiedWorkers
    .filter(
      (adapter) =>
        coordinator?.id !== 'claude' || adapter.id !== coordinator.id,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (!coordinator || workers.length === 0) return null;

  const coordinatorModel = readyModelForAdapter({
    adapter: coordinator,
    providers,
    accounts,
    preferredModel:
      coordinator.id === settings.defaultAdapterId
        ? settings.defaultModel
        : undefined,
    preferredAccountId:
      coordinator.id === settings.defaultAdapterId
        ? settings.defaultAccountId
        : undefined,
  });
  if (!coordinatorModel) return null;

  const roster: SquadAgent[] = [];
  const roles = recommendMissionRosterRoles({ objective, lane });
  for (const [index, role] of roles.entries()) {
    const adapter =
      role.category === 'orchestrator'
        ? coordinator
        : workers[(index - 1) % workers.length];
    if (!adapter) return null;
    const model =
      role.category === 'orchestrator'
        ? coordinatorModel
        : readyModelForAdapter({ adapter, providers, accounts });
    if (!model) return null;
    const effort = providerEffort(adapter.id, providers);
    roster.push({
      id: role.id,
      agentName: role.agentName,
      category: role.category,
      cli: adapter.id,
      model,
      ...(effort ? { effort } : {}),
      allowedSkills: [],
      allowedTools:
        role.allowedTools === null ? null : [...role.allowedTools],
    });
  }
  return roster;
}

export function missionRosterIssue(input: {
  roster: readonly SquadAgent[];
  lane: MissionLane;
  readiness: MissionRuntimeReadiness;
  providers: readonly ProviderSettingsInfo[];
  accounts: readonly AccountInfo[];
  entryContext?: MissionSetupEntryContext | null;
}): string | null {
  const parsed = strictSquadAgentSchema
    .array()
    .min(1)
    .max(MISSION_ROSTER_MAX_AGENTS)
    .safeParse(input.roster);
  if (!parsed.success) {
    return 'Revise os nomes e as configurações da equipe antes de continuar.';
  }
  const coordinators = input.roster.filter(
    (agent) => agent.category === 'orchestrator',
  );
  if (coordinators.length !== 1) {
    return 'A equipe precisa ter uma pessoa responsável por coordenar e revisar.';
  }
  if (
    input.roster.length === 1 &&
    (!isExactPetStudioEntryContext(input.entryContext) ||
      JSON.stringify(input.roster) !== JSON.stringify(PET_STUDIO_SQUAD.agents))
  ) {
    return 'Adicione ao menos uma pessoa para executar ou verificar a entrega.';
  }
  if (!isExactPetStudioEntryContext(input.entryContext)) {
    const deliveryIssue = missionDeliveryRosterIssue(input.roster, input.lane);
    if (deliveryIssue === 'executor-required') {
      return 'Adicione ao menos uma pessoa responsável por implementar ou executar a entrega.';
    }
    if (deliveryIssue === 'reviewer-required') {
      return 'Adicione ao menos uma pessoa independente para verificar a entrega.';
    }
  }

  // Doutrina fluxo-por-padrão: a equipe só é barrada por FORMA (schema, uma
  // coordenação, alguém para executar). Prontidão de ferramenta virou dica no
  // cartão — o terminal do agente é quem mostra login/instalação de verdade.
  // A única recusa que sobra é ferramenta desconhecida nesta máquina.
  for (const agent of input.roster) {
    const installed = input.readiness.detectedAdapters.some(
      (candidate) => candidate.id === agent.cli,
    );
    if (!installed) {
      return `A ferramenta de “${agent.agentName}” não está instalada nesta máquina. Troque a ferramenta desse papel.`;
    }
  }
  return null;
}

function issueForAgent(
  agent: SquadAgent,
  inventory: MissionTeamInventory,
): string | null {
  const adapter = inventory.readiness.detectedAdapters.find(
    (item) => item.id === agent.cli,
  );
  if (!adapter) {
    return 'Ferramenta não instalada nesta máquina — troque a ferramenta deste papel.';
  }
  if (
    !isAdapterModelAuthenticated(adapter, inventory.providers, agent.model)
  ) {
    return 'Ferramenta desligada nas configurações — religue ou troque a ferramenta.';
  }
  return null;
}

export function TeamStep({
  roster,
  lane,
  recommendationStale,
  revision,
  inventory,
  entryContext,
  onRosterChange,
  onBack,
  onContinue,
  onRetryInventory,
  onRefreshRecommendation,
}: TeamStepProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<HTMLUListElement>(null);
  const addRoleControlRef = useRef<HTMLButtonElement>(null);
  const pendingRemovalIndexRef = useRef<number | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const removedIndex = pendingRemovalIndexRef.current;
    if (removedIndex === null) return;
    pendingRemovalIndexRef.current = null;

    const rows =
      rosterRef.current?.querySelectorAll<HTMLElement>('.mission-roster-row');
    const adjacentRow = rows?.[removedIndex] ?? rows?.[removedIndex - 1];
    const adjacentControl = adjacentRow?.querySelector<HTMLElement>(
      'button:not(:disabled), summary',
    );
    (adjacentControl ?? addRoleControlRef.current)?.focus();
  }, [roster]);

  const rosterIssue =
    inventory.status === 'ready'
      ? missionRosterIssue({
          roster,
          lane,
          readiness: inventory.readiness,
          providers: inventory.providers,
          accounts: inventory.accounts,
          entryContext,
        })
      : inventory.status === 'error'
        ? inventory.error ?? 'Não foi possível conferir a equipe.'
        : 'A equipe ainda está sendo conferida.';

  const updateAgent = (nextAgent: SquadAgent): void => {
    setEditError(null);
    onRosterChange(
      roster.map((agent) =>
        agent.id === nextAgent.id ? { ...nextAgent } : { ...agent },
      ),
    );
  };

  const addAgent = (category: CustomizableWorkerCategory): void => {
    const customCount = roster.filter((agent) =>
      agent.id.startsWith(`custom-${category}-`),
    ).length;
    const built = buildCustomRosterAgent({
      category,
      lane,
      roster,
      adapters: inventory.readiness.qualifiedWorkers,
      providers: inventory.providers,
      now: revision + roster.length + 1,
    });
    if (!built.ok) {
      setEditError(
        built.error.includes('Limite')
          ? built.error
          : 'Não há outra ferramenta de IA pronta para adicionar.',
      );
      return;
    }
    const sourceProvider = inventory.providers.find(
      (provider) => provider.adapterId === built.agent.cli,
    );
    const effort = providerEffort(built.agent.cli, inventory.providers);
    const baseName =
      category === 'reviewer'
        ? 'Verificar outra parte'
        : category === 'scout'
          ? 'Pesquisar referências'
          : 'Implementar outra parte';
    const model =
      sourceProvider?.defaultModel || built.agent.model || undefined;
    const nextAgent = {
      ...built.agent,
      agentName:
        customCount === 0 ? baseName : `${baseName} ${customCount + 1}`,
    };
    if (effort) nextAgent.effort = effort;
    else delete nextAgent.effort;
    if (model) nextAgent.model = model;
    else delete nextAgent.model;
    onRosterChange([
      ...roster.map((agent) => ({ ...agent })),
      nextAgent,
    ]);
    setEditError(null);
  };

  const removeAgent = (agent: SquadAgent): void => {
    const planned = planRemoveRosterAgent(roster, agent.id);
    if (!planned.ok) {
      setEditError(
        planned.error.includes('ao menos')
          ? 'Mantenha ao menos uma pessoa além da coordenação.'
          : 'Não foi possível remover esse papel.',
      );
      return;
    }
    pendingRemovalIndexRef.current = roster.findIndex(
      (candidate) => candidate.id === agent.id,
    );
    onRosterChange(planned.next);
    setEditError(null);
  };

  /**
   * Presets de tamanho de equipe (padrão Bridge: RECON/SQUAD/CREW).
   *
   * Sem isto o operador só conseguia crescer a equipe um cartão por vez, e o
   * roster recomendado de 3 deixava um host de 8+ núcleos rodando duas frentes.
   * O preset é uma conveniência de composição: cada papel adicionado passa
   * pelo MESMO `buildCustomRosterAgent`, então nenhuma permissão nova é criada.
   */
  const applyTeamPreset = (targetTotal: number): void => {
    setEditError(null);
    let next = roster.map((agent) => ({ ...agent }));

    // Encolher: remove executores extras primeiro e preserva UM revisor —
    // a regra de forma exige verificação independente, e o preset "3" gerava
    // equipe sem revisor que travava o Continuar (beco sem saída).
    while (next.length > targetTotal) {
      const reviewers = next.filter((agent) => agent.category === 'reviewer');
      const removable =
        [...next]
          .reverse()
          .find(
            (agent) =>
              agent.category !== 'orchestrator' &&
              (agent.category !== 'reviewer' || reviewers.length > 1),
          ) ?? null;
      if (!removable) break;
      const planned = planRemoveRosterAgent(next, removable.id);
      if (!planned.ok) break;
      next = planned.next.map((agent) => ({ ...agent }));
    }

    // Crescer: acrescenta execução pela via já auditada.
    while (next.length < targetTotal) {
      const built = buildCustomRosterAgent({
        category: 'executor',
        lane,
        roster: next,
        adapters: inventory.readiness.qualifiedWorkers,
        providers: inventory.providers,
        now: revision + next.length + 1,
      });
      if (!built.ok) {
        setEditError(
          built.error.includes('Limite')
            ? built.error
            : 'Não há outra ferramenta de IA pronta para crescer a equipe.',
        );
        break;
      }
      const customCount = next.filter((agent) =>
        agent.id.startsWith('custom-executor-'),
      ).length;
      const sourceProvider = inventory.providers.find(
        (provider) => provider.adapterId === built.agent.cli,
      );
      const effort = providerEffort(built.agent.cli, inventory.providers);
      const model =
        sourceProvider?.defaultModel || built.agent.model || undefined;
      const nextAgent = {
        ...built.agent,
        agentName:
          customCount === 0
            ? 'Implementar outra parte'
            : `Implementar outra parte ${customCount + 1}`,
      };
      if (effort) nextAgent.effort = effort;
      else delete nextAgent.effort;
      if (model) nextAgent.model = model;
      else delete nextAgent.model;
      next = [...next, nextAgent];
    }

    onRosterChange(next);
  };

  const continueToReview = (): void => {
    if (rosterIssue) {
      setEditError(rosterIssue);
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }
    setEditError(null);
    onContinue();
  };

  return (
    <section className="mission-setup__step" aria-labelledby="mission-team-title">
      <header className="mission-setup__step-header">
        <p className="mission-setup__step-kicker">Etapa 2 · Equipe</p>
        <h1 id="mission-team-title" ref={headingRef} tabIndex={-1}>
          Monte a equipe
        </h1>
        <p>
          Cada cartão é um papel. Abra só o que quiser ajustar — o resto já vem
          pronto com a ferramenta conectada.
        </p>
      </header>

      <div className="mission-setup__continuous-section">
        <div className="mission-setup__section-heading">
          <h2>Papéis da missão</h2>
          <span className="mission-setup__count-chip">
            {roster.length} {roster.length === 1 ? 'integrante' : 'integrantes'}
          </span>
        </div>

        {inventory.status === 'ready' &&
          inventory.readiness.hasOperationalRoute && (
            <div className="mission-setup__presets">
              <span className="mission-setup__presets-label">
                Tamanho da equipe
              </span>
              <div
                className="mission-setup__preset-row"
                role="group"
                aria-label="Tamanho da equipe"
              >
                {TEAM_PRESETS.map((preset) => (
                  <button
                    key={preset.total}
                    type="button"
                    className="mission-setup__preset"
                    aria-pressed={roster.length === preset.total}
                    onClick={() => applyTeamPreset(preset.total)}
                  >
                    <strong>{preset.total}</strong>
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
              <p className="mission-setup__hint">
                Mais gente = mais terminais em paralelo. O limite da máquina
                continua valendo.
              </p>
            </div>
          )}

        {recommendationStale && (
          <div
            className="mission-setup__error-summary"
            role="status"
            aria-live="polite"
          >
            <strong>
              A equipe não corresponde mais ao tipo de trabalho
            </strong>
            <span>
              A composição personalizada foi preservada com permissões seguras.
            </span>
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              disabled={
                inventory.status !== 'ready' ||
                !inventory.readiness.hasOperationalRoute
              }
              onClick={onRefreshRecommendation}
            >
              Atualizar recomendação
            </button>
          </div>
        )}

        {inventory.status === 'loading' && (
          <p className="mission-setup__status" role="status" aria-live="polite">
            Conferindo as ferramentas disponíveis…
          </p>
        )}

        {inventory.status === 'error' && (
          <div
            ref={errorRef}
            className="mission-setup__error-summary"
            role="alert"
            tabIndex={-1}
          >
            <strong>Não foi possível conferir a equipe.</strong>
            <span>{inventory.error}</span>
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onRetryInventory}
            >
              Tentar carregar equipe
            </button>
          </div>
        )}

        {inventory.status === 'ready' && !inventory.readiness.hasOperationalRoute && (
          <div
            ref={errorRef}
            className="mission-setup__error-summary"
            role="alert"
            tabIndex={-1}
          >
            <strong>Não há uma equipe segura disponível.</strong>
            <span>
              Conecte uma ferramenta capaz de coordenar e outra capaz de receber
              trabalho antes de continuar.
            </span>
          </div>
        )}

        {roster.length > 0 && (
          <ul
            ref={rosterRef}
            className="mission-roster"
            aria-label="Papéis da equipe"
          >
            {roster.map((agent) => (
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
                removable={agent.category !== 'orchestrator'}
                onChange={updateAgent}
                onRemove={() => removeAgent(agent)}
              />
            ))}
          </ul>
        )}
      </div>

      {inventory.status === 'ready' && inventory.readiness.hasOperationalRoute && (
        <div className="mission-setup__continuous-section mission-setup__team-actions">
          <h2>Adicionar papel</h2>
          <div className="mission-setup__inline-actions mission-setup__role-chips">
            <button
              ref={addRoleControlRef}
              type="button"
              className="mission-setup__role-chip"
              onClick={() => addAgent('executor')}
            >
              <span aria-hidden="true">⚒</span>
              Adicionar implementação
            </button>
            <button
              type="button"
              className="mission-setup__role-chip"
              onClick={() => addAgent('reviewer')}
            >
              <span aria-hidden="true">◎</span>
              Adicionar verificação
            </button>
          </div>
        </div>
      )}

      {editError && (
        <div
          ref={errorRef}
          className="mission-setup__error-summary"
          role="alert"
          tabIndex={-1}
        >
          {editError}
        </div>
      )}

      <footer className="mission-setup__step-actions">
        <button
          type="button"
          className="mission-setup__button mission-setup__button--secondary"
          onClick={onBack}
        >
          Voltar para missão
        </button>
        <button
          type="button"
          className="mission-setup__button mission-setup__button--primary"
          onClick={continueToReview}
          aria-describedby={rosterIssue ? 'mission-team-continue-reason' : undefined}
        >
          Continuar para revisão
        </button>
      </footer>
      {rosterIssue && (
        <p id="mission-team-continue-reason" className="mission-setup__hint">
          {rosterIssue}
        </p>
      )}
    </section>
  );
}
