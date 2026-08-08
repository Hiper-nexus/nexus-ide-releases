import { useEffect, useRef, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import type { MissionLane } from '../../../shared/mission-intent';
import {
  strictSquadAgentSchema,
  type SquadAgent,
} from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import type { OrchSettings } from '../../../shared/settings-types';
import type { AdapterInfo } from '../../../shared/types';
import {
  isAdapterModelAuthenticated,
  type MissionRuntimeReadiness,
} from '../../orch/mission-runtime-readiness';
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
  readiness: MissionRuntimeReadiness;
  providers: readonly ProviderSettingsInfo[];
  accounts: readonly AccountInfo[];
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
  if (input.roster.length === 1) {
    return 'Adicione ao menos uma pessoa para executar ou verificar a entrega.';
  }

  const coordinatorIds = new Set(
    input.readiness.verifiedMaestros.map((adapter) => adapter.id),
  );
  const workerIds = new Set(
    input.readiness.qualifiedWorkers.map((adapter) => adapter.id),
  );
  for (const agent of input.roster) {
    const qualified =
      agent.category === 'orchestrator'
        ? coordinatorIds.has(agent.cli)
        : workerIds.has(agent.cli);
    const adapter = [
      ...input.readiness.verifiedMaestros,
      ...input.readiness.qualifiedWorkers,
    ].find((candidate) => candidate.id === agent.cli);
    if (
      !qualified ||
      !adapter ||
      !isAdapterModelAuthenticated(
        adapter,
        input.providers,
        agent.model,
        input.accounts,
      )
    ) {
      return `A ferramenta escolhida para “${agent.agentName}” não está pronta. Abra as configurações técnicas desse papel.`;
    }
  }
  return null;
}

function issueForAgent(
  agent: SquadAgent,
  inventory: MissionTeamInventory,
): string | null {
  const qualified =
    agent.category === 'orchestrator'
      ? inventory.readiness.verifiedMaestros
      : inventory.readiness.qualifiedWorkers;
  const adapter = qualified.find((item) => item.id === agent.cli);
  if (!adapter) return 'A ferramenta escolhida não está pronta para este papel.';
  if (
    !isAdapterModelAuthenticated(
      adapter,
      inventory.providers,
      agent.model,
      inventory.accounts,
    )
  ) {
    return 'Escolha um modelo conectado e disponível.';
  }
  return null;
}

export function TeamStep({
  roster,
  lane,
  recommendationStale,
  revision,
  inventory,
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
          readiness: inventory.readiness,
          providers: inventory.providers,
          accounts: inventory.accounts,
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
    onRosterChange([
      ...roster.map((agent) => ({ ...agent })),
      {
        ...built.agent,
        agentName:
          customCount === 0 ? baseName : `${baseName} ${customCount + 1}`,
        ...(effort ? { effort } : { effort: undefined }),
        model:
          sourceProvider?.defaultModel || built.agent.model || undefined,
      },
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
        <p className="mission-setup__step-kicker">Equipe</p>
        <h1 id="mission-team-title" ref={headingRef} tabIndex={-1}>
          Quem vai cuidar da entrega
        </h1>
        <p>
          A recomendação prioriza ferramentas conectadas e papéis claros. Abra
          um papel somente se quiser ajustar os detalhes técnicos.
        </p>
      </header>

      <div className="mission-setup__continuous-section">
        <div className="mission-setup__section-heading">
          <h2>Equipe recomendada</h2>
          <span>{roster.length} integrantes</span>
        </div>

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
          <h2>Adicionar outro papel</h2>
          <div className="mission-setup__inline-actions">
            <button
              ref={addRoleControlRef}
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={() => addAgent('executor')}
            >
              Adicionar implementação
            </button>
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={() => addAgent('reviewer')}
            >
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
