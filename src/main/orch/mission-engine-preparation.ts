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
  type MissionAttachmentSnapshot,
  type MissionIntentContract,
  type MissionLane,
  type MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type { Mission, Squad, SquadAgent } from '../../shared/orch-types';
import {
  PET_STUDIO_SQUAD,
  PET_STUDIO_SQUAD_ID,
} from '../../shared/pet-studio';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  releaseSealedAttachmentSnapshots,
  sealGovernedAttachmentPath,
  sweepSealedAttachmentOrphans,
  workspaceRootAuthorityFromScope,
} from '../persistence/dropped-files';
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
  list?(): Mission[];
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
  readonly sealPetStudioImage?: (
    scope: ProjectExecutionScope,
    sourcePath: string,
  ) => MissionAttachmentSnapshot;
  readonly releasePetStudioAttachments?: (
    scope: ProjectExecutionScope,
    snapshots: readonly MissionAttachmentSnapshot[],
  ) => number;
  readonly sweepPetStudioAttachmentOrphans?: (
    scope: ProjectExecutionScope,
    liveSnapshots: readonly MissionAttachmentSnapshot[],
  ) => number;
}

export type MissionEnginePreparationPorts = Pick<
  MainMissionEnginePorts,
  'arm' | 'compile' | 'persistReviewFence' | 'discardUnfencedPreparation'
>;
const PET_STUDIO_DENIED_TOOLS = Object.freeze([
  'route_task',
  'pane_spawn',
  'task',
  'worktree_create',
  'worktree_merge',
]);

const PET_STUDIO_ACCEPTANCE_CRITERIA = Object.freeze([
  'A sessão Codex única usa somente a imagem governada como referência.',
  'O pacote final segue o workflow completo da skill nexus-pet-studio.',
  'O handoff final informa o pacote, manifesto e evidências verificáveis.',
]);

function isPetStudioRequest(request: MissionPrepareRequest): boolean {
  return request.profile?.kind === 'pet-studio';
}

function isExactPetStudioSquad(squad: Squad): boolean {
  return (
    squad.id === PET_STUDIO_SQUAD_ID &&
    isDeepStrictEqual(squad, PET_STUDIO_SQUAD)
  );
}

function requireSealedPetStudioSnapshot(
  snapshot: MissionAttachmentSnapshot,
): MissionAttachmentSnapshot {
  if (
    snapshot.sourcePath === undefined ||
    snapshot.sealId === undefined ||
    snapshot.device === undefined ||
    snapshot.inode === undefined
  ) {
    throw new Error('Pet Studio requires a complete sealed image identity');
  }
  return snapshot;
}


function assertRosterShape(
  roster: readonly SquadAgent[],
  lane: MissionLane = 'standard',
  allowSingleSeat = false,
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
  if (roster.length < 2 && !allowSingleSeat) {
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
  if (isPetStudioRequest(request)) {
    return structuredClone(PET_STUDIO_SQUAD);
  }
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
  if (isPetStudioRequest(request)) {
    const saved = getSquad(PET_STUDIO_SQUAD_ID);
    if (!saved || !isExactPetStudioSquad(saved)) {
      throw new Error('A autoridade salva do Pet Studio não está disponível.');
    }
    const orchestrator = assertRosterShape(saved.agents, 'standard', true);
    resolveProductionMissionOrchestratorRuntime(saved, orchestrator, undefined, {
      requireProviderReadiness: false,
    });
    return saved;
  }
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
  resolveProductionMissionOrchestratorRuntime(
    candidate.squad,
    orchestrator,
    undefined,
    { requireProviderReadiness: false },
  );
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
    resolveProductionMissionOrchestratorRuntime(
      squad,
      orchestrator,
      undefined,
      { requireProviderReadiness: false },
    ),
  sealPetStudioImage: (scope, sourcePath) =>
    sealGovernedAttachmentPath(sourcePath, {
      workspaceRootAuthority: workspaceRootAuthorityFromScope(scope),
      checkoutId: scope.checkoutId,
    }),
  releasePetStudioAttachments: (scope, snapshots) =>
    releaseSealedAttachmentSnapshots(snapshots, {
      checkoutId: scope.checkoutId,
    }),
  sweepPetStudioAttachmentOrphans: (scope, snapshots) =>
    sweepSealedAttachmentOrphans({
      checkoutId: scope.checkoutId,
      liveSnapshots: snapshots,
    }),
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
const PET_STUDIO_PERMISSIONS = Object.freeze([
  {
    id: 'pet-image-generation',
    label: 'Gerar imagens para este pet',
    detail: 'Somente pela skill nexus-pet-studio na sessão Codex revisada.',
  },
]) satisfies readonly MissionPermission[];


function warningsForMission(
  contract: MissionIntentContract,
  squad: Squad,
): string[] {
  if (isExactPetStudioSquad(squad)) {
    return ['A execução permanece em uma única sessão, sem delegação.'];
  }
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
  const sealPetStudioImage =
    deps.sealPetStudioImage ?? productionDeps.sealPetStudioImage!;
  const releasePetStudioAttachments =
    deps.releasePetStudioAttachments ??
    productionDeps.releasePetStudioAttachments!;
  if (!input.deps && missions.list) {
    const liveSnapshots = missions
      .list()
      .flatMap(
        (mission) => mission.intentContract?.attachmentSnapshots ?? [],
      );
    try {
      productionDeps.sweepPetStudioAttachmentOrphans!(scope, liveSnapshots);
    } catch (error) {
      console.warn(
        '[mission-preparation] sealed attachment orphan sweep skipped',
        error,
      );
    }
  }
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
    const sealedSnapshots = contract.attachmentSnapshots?.filter(
      (snapshot) =>
        snapshot.sourcePath !== undefined &&
        snapshot.sealId !== undefined &&
        snapshot.device !== undefined &&
        snapshot.inode !== undefined,
    );
    if (sealedSnapshots && sealedSnapshots.length > 0) {
      try {
        releasePetStudioAttachments(scope, sealedSnapshots);
      } catch (error) {
        console.warn(
          '[mission-preparation] sealed attachment cleanup after cancellation skipped',
          error,
        );
      }
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
      const parsedRequest = missionPrepareRequestSchema.parse(rawRequest);
      const petSnapshot =
        parsedRequest.profile?.kind === 'pet-studio'
          ? requireSealedPetStudioSnapshot(
              sealPetStudioImage(
                scope,
                parsedRequest.profile.referenceImagePath,
              ),
            )
          : null;
      const request = petSnapshot
        ? missionPrepareRequestSchema.parse({
            ...parsedRequest,
            contextPaths: [],
            roster: structuredClone(PET_STUDIO_SQUAD.agents),
            advanced: { lane: 'standard' },
            profile: {
              kind: 'pet-studio',
              referenceImagePath: petSnapshot.path,
            },
          })
        : parsedRequest;
      const petStudio = petSnapshot !== null;
      assertRosterShape(
        request.roster,
        request.advanced?.lane ?? 'standard',
        petStudio,
      );
      const squad = deps.persistRuntimeSquad(request);
      if (petStudio && !isExactPetStudioSquad(squad)) {
        throw new Error('A autoridade preparada do Pet Studio não é canônica.');
      }
      const baseContract = compileIntentContract({
        goal: request.objective,
        source: 'typed',
        intentVersion: 1,
        lane: request.advanced?.lane ?? 'standard',
        contextPolicy:
          request.contextPaths.length > 0 ? 'minimal' : 'on-demand',
        contextPaths: [...request.contextPaths],
        ...(petStudio
          ? { acceptanceCriteria: [...PET_STUDIO_ACCEPTANCE_CRITERIA] }
          : request.acceptanceCriteria
            ? { acceptanceCriteria: [...request.acceptanceCriteria] }
            : {}),
      });
      const contract = missionIntentContractSchema.parse(
        petStudio
          ? {
              ...baseContract,
              budgets: { ...baseContract.budgets, maxWorkers: 0 },
              deniedTools: [...PET_STUDIO_DENIED_TOOLS],
              attachmentPaths: [petSnapshot.path],
              attachmentSnapshots: [{ ...petSnapshot }],
            }
          : baseContract,
      );
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
      const petStudio = request.profile?.kind === 'pet-studio';
      if (
        (petStudio && !isExactPetStudioSquad(squad)) ||
        (!petStudio && squad.id === PET_STUDIO_SQUAD_ID)
      ) {
        throw new Error('A autoridade do Pet Studio mudou antes da revisão.');
      }
      const petAttachment = mission.intentContract.attachmentSnapshots?.[0];
      if (
        petStudio &&
        (mission.intentContract.attachmentPaths?.length !== 1 ||
          mission.intentContract.attachmentSnapshots?.length !== 1 ||
          mission.intentContract.attachmentPaths[0] !== petAttachment?.path ||
          petAttachment?.sourcePath === undefined ||
          petAttachment?.sealId === undefined ||
          petAttachment?.device === undefined ||
          petAttachment?.inode === undefined)
      ) {
        throw new Error('A imagem governada do Pet Studio não está disponível.');
      }
      assertRosterShape(
        squad.agents,
        mission.intentContract.lane ?? 'standard',
        petStudio,
      );
      return {
        title: mission.title,
        objective: mission.intentContract.goal,
        contextPaths: [...(mission.intentContract.contextPaths ?? [])],
        acceptanceCriteria: [...mission.intentContract.acceptanceCriteria],
        roster: squad.agents.map((agent) => ({
          ...agent,
          allowedTools: agent.allowedTools ? [...agent.allowedTools] : agent.allowedTools,
          allowedSkills: agent.allowedSkills
            ? [...agent.allowedSkills]
            : agent.allowedSkills,
        })),
        ...(petStudio
          ? {
              attachments: mission.intentContract.attachmentSnapshots!.map(
                (snapshot) => ({ ...snapshot }),
              ),
            }
          : {}),
        permissions: petStudio
          ? PET_STUDIO_PERMISSIONS.map((permission) => ({ ...permission }))
          : permissionsForLane(mission.intentContract.lane),
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
        const petStudio = squad.id === PET_STUDIO_SQUAD_ID;
        if (petStudio && !isExactPetStudioSquad(squad)) {
          throw new Error('A autoridade persistida do Pet Studio mudou.');
        }
        const orchestrator = assertRosterShape(
          squad.agents,
          mission.intentContract.lane ?? 'standard',
          petStudio,
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
