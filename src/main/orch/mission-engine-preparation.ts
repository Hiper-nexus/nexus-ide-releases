import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  missionPrepareRequestSchema,
  type MissionPermission,
  type MissionPrepareRequest,
} from '../../shared/mission-engine-contract';
import {
  compileIntentContract,
  missionLaneAllowsTools,
  missionIntentContractSchema,
  type MissionIntentContract,
  type MissionLane,
  type MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  MainMissionEnginePorts,
  MissionArmResult,
  MissionCompilation,
  MissionReviewFence,
} from './mission-engine';
import { resolveProductionMissionOrchestratorRuntime } from './mission-orchestrator-runtime';
import {
  applyPreparedSquadSave,
  discardMissionRuntimeSquadIfUnchanged,
  getSquad,
  prepareMissionRuntimeSquadSave,
} from './squad-store';
import { snapshotSquadAuthority } from './squad-authority-snapshot';

interface MissionPreparationStore {
  create(input: {
    title: string;
    description?: string;
    squadId?: string;
    intentState?: Mission['intentState'];
    intentContract?: MissionIntentContract;
    intentVersion?: number;
  }): Mission;
  get(missionId: string): Mission | null;
  bindMissionRuntimeSquad(
    missionId: string,
    expected: Mission,
    squadId: string,
    contract?: MissionIntentContract,
  ): Mission;
  removeIfUnchanged(
    missionId: string,
    expected: Readonly<Mission>,
  ): 'removed' | 'missing' | 'changed';
}

export interface MissionEnginePreparationDeps {
  readonly now: () => number;
  readonly persistRuntimeSquad: (request: MissionPrepareRequest) => Squad;
  readonly getSquad: (squadId: string) => Squad | null;
  readonly resolveRuntime: (
    squad: Squad,
    orchestrator: SquadAgent,
  ) => MissionOrchestratorRuntimeSnapshot;
  readonly discardRuntimeSquad: (squad: Squad) => boolean;
}

export type MissionEnginePreparationPorts = Pick<
  MainMissionEnginePorts,
  'arm' | 'compile' | 'persistReviewFence' | 'discardUnfencedPreparation'
>;

function assertRosterShape(
  roster: readonly SquadAgent[],
  lane: MissionLane = 'standard',
): SquadAgent {
  const ids = new Set<string>();
  for (const agent of roster) {
    if (ids.has(agent.id)) {
      throw new Error(`A equipe contém o identificador repetido \`${agent.id}\`.`);
    }
    ids.add(agent.id);
    if (
      agent.allowedTools === undefined ||
      agent.allowedSkills === undefined
    ) {
      throw new Error(
        `O papel \`${agent.agentName}\` não possui permissões revisadas.`,
      );
    }
  }
  const coordinators = roster.filter(
    (agent) => agent.category === 'orchestrator',
  );
  if (coordinators.length !== 1) {
    throw new Error('A equipe precisa ter exatamente um coordenador (orchestrator).');
  }
  if (roster.length < 2) {
    throw new Error('A equipe precisa ter ao menos um papel além do coordenador.');
  }
  for (const agent of roster) {
    if (!missionLaneAllowsTools(lane, agent.category, agent.allowedTools)) {
      throw new Error(
        `O papel \`${agent.agentName}\` excede as permissões da modalidade \`${lane}\`.`,
      );
    }
  }
  return coordinators[0]!;
}

function missionTitle(request: MissionPrepareRequest): string {
  const explicit = request.title?.trim();
  if (explicit) return explicit.slice(0, 512);
  return request.objective.split(/\r?\n/u, 1)[0]!.trim().slice(0, 512);
}

function sourceSquadForRequest(request: MissionPrepareRequest): Squad {
  const id = `custom-mission-setup-${randomUUID()}`;
  const title = missionTitle(request);
  return {
    id,
    name: `Equipe — ${title}`.slice(0, 256),
    createdAt: String(Date.now()),
    builtin: false,
    orchestratorInstructions: [
      '# Missão aprovada no Nexus',
      'Coordene somente o objetivo e os limites persistidos no contrato da missão.',
      'Delegue pelos papéis da equipe e exija evidência antes de concluir.',
      '',
      request.objective,
    ].join('\n'),
    agents: request.roster.map((agent) => ({
      ...agent,
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : agent.allowedTools,
      allowedSkills: agent.allowedSkills
        ? [...agent.allowedSkills]
        : agent.allowedSkills,
    })),
  };
}

function persistRuntimeSquad(request: MissionPrepareRequest): Squad {
  const source = sourceSquadForRequest(request);
  const sourceSnapshot = snapshotSquadAuthority(source);
  const candidate = prepareMissionRuntimeSquadSave(
    {
      ...source,
      id: `agentic-runtime-${randomUUID()}`,
      createdAt: String(Date.now()),
      runtimeSourceSquadId: source.id,
      runtimeSourceSquadRevisionHash: sourceSnapshot.hash,
      agents: source.agents.map((agent) => ({ ...agent })),
    },
    source,
    false,
    'ephemeral',
  );
  if (!isDeepStrictEqual(candidate.squad.agents, request.roster)) {
    throw new Error(
      'A autoridade da equipe mudou durante a preparação da missão.',
    );
  }
  const orchestrator = assertRosterShape(
    candidate.squad.agents,
    request.advanced?.lane ?? 'standard',
  );
  resolveProductionMissionOrchestratorRuntime(candidate.squad, orchestrator);
  return applyPreparedSquadSave(candidate);
}

const productionDeps: MissionEnginePreparationDeps = {
  now: Date.now,
  persistRuntimeSquad,
  discardRuntimeSquad: (squad) =>
    discardMissionRuntimeSquadIfUnchanged(
      squad.id,
      snapshotSquadAuthority(squad).hash,
    ),
  getSquad,
  resolveRuntime: (squad, orchestrator) =>
    resolveProductionMissionOrchestratorRuntime(squad, orchestrator),
};

function permissionsForLane(
  lane: NonNullable<MissionPrepareRequest['advanced']>['lane'] = 'standard',
): MissionPermission[] {
  const readProject: MissionPermission = {
    id: 'workspace-read',
    label: 'Ler arquivos do projeto',
    detail: 'Somente o projeto selecionado e os contextos aprovados.',
  };
  switch (lane) {
    case 'consult':
      return [
        readProject,
        {
          id: 'read-only-inspection',
          label: 'Executar inspeções sem alterar o projeto',
          detail: 'A missão permanece em modo de consulta.',
        },
      ];
    case 'plan':
      return [
        readProject,
        {
          id: 'plan-write',
          label: 'Criar ou atualizar o plano da missão',
          detail: 'Código do produto permanece sem alterações.',
        },
      ];
    case 'ops':
      return [
        readProject,
        {
          id: 'operations',
          label: 'Operar infraestrutura autorizada',
          detail: 'Comandos e navegador seguem os limites do contrato aprovado.',
        },
      ];
    case 'standard':
      return [
        readProject,
        {
          id: 'workspace-write',
          label: 'Alterar arquivos do projeto',
          detail: 'Somente dentro da pasta selecionada e dos worktrees da missão.',
        },
        {
          id: 'local-commands',
          label: 'Executar comandos locais',
          detail: 'Sob sandbox, orçamento e ferramentas aprovadas para cada papel.',
        },
      ];
  }
}

function warningsForMission(
  contract: MissionIntentContract,
  squad: Squad,
): string[] {
  const warnings: string[] = [];
  if (contract.risk === 'sensitive') {
    warnings.push('O objetivo toca uma área sensível; efeitos continuam sujeitos aos gates do Nexus.');
  } else if (contract.risk === 'destructive') {
    warnings.push('O objetivo pode ser destrutivo; revise backups, escopo e comandos antes de iniciar.');
  }
  const unrestricted = squad.agents.filter(
    (agent) => agent.allowedTools === null,
  );
  if (unrestricted.length > 0) {
    warnings.push(
      `${unrestricted.length} papéis possuem ferramentas sem lista restrita; a autoridade da lane ainda prevalece.`,
    );
  }
  return warnings;
}

export function createMissionEnginePreparationPorts(input: {
  readonly scope: ProjectExecutionScope;
  readonly missions: MissionPreparationStore;
  readonly deps?: MissionEnginePreparationDeps;
}): MissionEnginePreparationPorts {
  const { scope, missions } = input;
  const deps = input.deps ?? productionDeps;
  const discardUnfencedMission = (mission: Mission): boolean => {
    const contract = mission.intentContract;
    if (
      mission.status !== 'pending' ||
      mission.intentState !== 'ready_to_start' ||
      mission.orchestratorSessionId !== undefined ||
      !mission.squadId ||
      !contract ||
      mission.intentVersion !== contract.intentVersion ||
      contract.approvedAt !== undefined ||
      contract.approvalReviewSha256 !== undefined ||
      contract.dispatchedAt !== undefined ||
      contract.squadRevisionHash !== undefined ||
      contract.orchestratorRuntime !== undefined
    ) {
      return false;
    }
    const runtimeSquad = deps.getSquad(mission.squadId);
    if (missions.removeIfUnchanged(mission.id, mission) !== 'removed') {
      return false;
    }
    if (runtimeSquad) deps.discardRuntimeSquad(runtimeSquad);
    return true;
  };
  const discardUnfencedPreparation = async ({
    missionId,
    createdAt,
  }: Pick<MissionArmResult, 'missionId' | 'createdAt'>): Promise<boolean> => {
    const mission = missions.get(missionId);
    if (!mission || mission.createdAt !== createdAt) return false;
    return discardUnfencedMission(mission);
  };


  return {
    discardUnfencedPreparation,
    arm: async (rawRequest): Promise<MissionArmResult> => {
      const request = missionPrepareRequestSchema.parse(rawRequest);
      assertRosterShape(
        request.roster,
        request.advanced?.lane ?? 'standard',
      );
      const squad = deps.persistRuntimeSquad(request);
      const contract = compileIntentContract({
        goal: request.objective,
        source: 'typed',
        intentVersion: 1,
        lane: request.advanced?.lane ?? 'standard',
        contextPolicy: request.contextPaths.length > 0 ? 'minimal' : 'on-demand',
        contextPaths: [...request.contextPaths],
      });
      let mission: Mission;
      try {
        mission = missions.create({
          title: missionTitle(request),
          description: request.objective,
          squadId: squad.id,
          intentState: 'ready_to_start',
          intentVersion: 1,
          intentContract: contract,
        });
      } catch (error) {
        deps.discardRuntimeSquad(squad);
        throw error;
      }
      return {
        missionId: mission.id,
        workspaceLabel: scope.rootRealPath,
        createdAt: mission.createdAt,
      };
    },

    compile: async (rawRequest, armed): Promise<MissionCompilation> => {
      const request = missionPrepareRequestSchema.parse(rawRequest);
      const mission = missions.get(armed.missionId);
      if (
        !mission ||
        mission.createdAt !== armed.createdAt ||
        mission.intentContract?.goal !== request.objective ||
        mission.intentContract.intentVersion !== 1 ||
        mission.squadId === undefined
      ) {
        throw new Error('A preparação da missão mudou antes da revisão.');
      }
      const squad = deps.getSquad(mission.squadId);
      if (!squad) {
        const error = new Error('A equipe preparada não está mais disponível.');
        try {
          discardUnfencedMission(mission);
        } catch (rollbackError) {
          console.warn(
            `[mission-engine] failed to discard unfenced preparation ${mission.id}:`,
            rollbackError,
          );
        }
        throw error;
      }
      assertRosterShape(
        squad.agents,
        mission.intentContract.lane ?? 'standard',
      );
      return {
        title: mission.title,
        objective: mission.intentContract.goal,
        contextPaths: [...(mission.intentContract.contextPaths ?? [])],
        roster: squad.agents.map((agent) => ({
          ...agent,
          allowedTools: agent.allowedTools ? [...agent.allowedTools] : agent.allowedTools,
          allowedSkills: agent.allowedSkills
            ? [...agent.allowedSkills]
            : agent.allowedSkills,
        })),
        permissions: permissionsForLane(mission.intentContract.lane),
        warnings: warningsForMission(mission.intentContract, squad),
      };
    },

    persistReviewFence: async (fence: MissionReviewFence): Promise<void> => {
      const mission = missions.get(fence.missionId);
      if (!mission?.intentContract || !mission.squadId) {
        throw new Error('A missão preparada não está mais disponível.');
      }
      try {
        if (
          mission.status !== 'pending' ||
          mission.intentState !== 'ready_to_start' ||
          mission.intentVersion !== mission.intentContract.intentVersion ||
          mission.intentContract.approvalReviewSha256 !== undefined
        ) {
          throw new Error('A autoridade da revisão mudou antes da persistência.');
        }
        const squad = deps.getSquad(mission.squadId);
        if (!squad) {
          throw new Error('A equipe preparada não está mais disponível.');
        }
        const orchestrator = assertRosterShape(
          squad.agents,
          mission.intentContract.lane ?? 'standard',
        );
        const runtime = deps.resolveRuntime(squad, orchestrator);
        const squadHash = snapshotSquadAuthority(squad).hash;
        const contract = missionIntentContractSchema.parse({
          ...mission.intentContract,
          approvedAt: deps.now(),
          approvalReviewSha256: fence.reviewSha256,
          squadRevisionHash: squadHash,
          orchestratorRuntime: { ...runtime },
        });
        const persisted = missions.bindMissionRuntimeSquad(
          mission.id,
          mission,
          squad.id,
          contract,
        );
        if (
          persisted.intentContract?.approvalReviewSha256 !==
            fence.reviewSha256 ||
          persisted.intentContract.squadRevisionHash !== squadHash
        ) {
          throw new Error('A revisão não foi persistida com a autoridade exata.');
        }
      } catch (error) {
        try {
          discardUnfencedMission(mission);
        } catch (rollbackError) {
          console.warn(
            `[mission-engine] failed to discard unfenced preparation ${mission.id}:`,
            rollbackError,
          );
        }
        throw error;
      }
    },
  };
}
