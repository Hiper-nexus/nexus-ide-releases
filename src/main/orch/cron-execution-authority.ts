import { createHash } from 'node:crypto';
import {
  compileIntentContract,
  missionIntentContractSchema,
  type MissionIntentContract,
} from '../../shared/mission-intent';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  cronExecutionAuthoritySchema,
  type CronExecutionAuthority,
  type CronJob,
} from './cron-loop';
import {
  signCronAuthority,
  verifyCronAuthority,
} from './cron-authority-auth';
import {
  canonicalMissionOrchestratorRuntime,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
} from './mission-orchestrator-runtime';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { getSquad, listSquads } from './squad-store';
import { resolveCwdForScope } from './workspace-path';

export interface CronExactUserConsent {
  readonly toolName: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly grantedAt: number;
  readonly receiptId: string;
}

export interface CronExecutionAuthorityDeps {
  readonly getSquad: (id: string) => Squad | null;
  readonly listSquads: () => readonly Squad[];
  readonly resolveRuntime: (
    squad: Squad,
    orchestrator: SquadAgent,
  ) => ReturnType<typeof resolveProductionMissionOrchestratorRuntime>;
}

const productionDeps: CronExecutionAuthorityDeps = {
  getSquad: (id) => getSquad(id),
  listSquads: () => listSquads(),
  resolveRuntime: (squad, orchestrator) =>
    resolveProductionMissionOrchestratorRuntime(squad, orchestrator),
};

type CronAuthoritySubject = Pick<
  CronJob,
  | 'id'
  | 'name'
  | 'schedule'
  | 'brief'
  | 'status'
  | 'executionMode'
  | 'portableScheduleId'
  | 'definitionVersion'
  | 'definitionHash'
  | 'workspacePath'
  | 'workingDirectory'
  | 'projectId'
  | 'checkoutId'
  | 'agentName'
  | 'squadId'
  | 'executionAuthority'
>;

interface ResolvedCronTarget {
  readonly squad: Squad;
  readonly orchestrator: SquadAgent;
  readonly targetAgent?: SquadAgent;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath &&
    left.identitySource === right.identitySource
  );
}

function requirePrimaryOrchestrator(squad: Squad): SquadAgent {
  const orchestrator = squad.agents.find(
    (agent) => agent.category === 'orchestrator',
  );
  if (!orchestrator) {
    throw new Error(
      `cron_execution_authority_invalid: squad ${squad.id} has no orchestrator`,
    );
  }
  return orchestrator;
}

function resolveTargetForIssue(
  subject: CronAuthoritySubject,
  deps: CronExecutionAuthorityDeps,
): ResolvedCronTarget {
  if (Boolean(subject.agentName) === Boolean(subject.squadId)) {
    throw new Error(
      'cron_execution_authority_invalid: exactly one agentName or squadId is required',
    );
  }
  if (subject.squadId) {
    const squad = deps.getSquad(subject.squadId);
    if (!squad) {
      throw new Error(
        `cron_execution_authority_invalid: squad ${subject.squadId} is unavailable`,
      );
    }
    return { squad, orchestrator: requirePrimaryOrchestrator(squad) };
  }
  const reference = subject.agentName!;
  const matches = deps
    .listSquads()
    .flatMap((squad) =>
      squad.agents
        .filter(
          (agent) => agent.id === reference || agent.agentName === reference,
        )
        .map((agent) => ({ squad, agent })),
    );
  if (matches.length !== 1) {
    throw new Error(
      'cron_execution_authority_invalid: agentName must resolve to one exact saved-roster agent',
    );
  }
  const [{ squad, agent }] = matches;
  const orchestrator = requirePrimaryOrchestrator(squad);
  if (agent.category === 'orchestrator' && agent.id !== orchestrator.id) {
    throw new Error(
      'cron_execution_authority_invalid: scheduled orchestrator must be the squad primary',
    );
  }
  return { squad, orchestrator, targetAgent: agent };
}

function resolvedWorkingDirectory(
  subject: CronAuthoritySubject,
  scope: ProjectExecutionScope,
): string {
  if (
    subject.workspacePath !== undefined &&
    subject.workspacePath !== scope.rootRealPath
  ) {
    throw new Error(
      'cron_execution_authority_invalid: workspace binding changed',
    );
  }
  if (
    subject.projectId !== undefined &&
    subject.projectId !== scope.projectId
  ) {
    throw new Error(
      'cron_execution_authority_invalid: project binding changed',
    );
  }
  if (
    subject.checkoutId !== undefined &&
    subject.checkoutId !== scope.checkoutId
  ) {
    throw new Error(
      'cron_execution_authority_invalid: checkout binding changed',
    );
  }
  return resolveCwdForScope(scope, subject.workingDirectory);
}

function missionGoal(
  subject: CronAuthoritySubject,
  target: ResolvedCronTarget,
  workingDirectory: string,
): string {
  const directoryNote =
    workingDirectory === subject.workspacePath
      ? ''
      : `\nDiretório de trabalho aprovado: ${workingDirectory}`;
  const targetNote = target.targetAgent
    ? target.targetAgent.category === 'orchestrator'
      ? `Coordene esta execução no orquestrador salvo ${target.targetAgent.agentName}.`
      : `O plano deve conter exatamente UMA tarefa e atribuí-la ao worker salvo ` +
        `${target.targetAgent.agentName} (${target.targetAgent.id}); o motor rejeita substituições.`
    : `Planeje e execute com o roster salvo do squad ${target.squad.name} (${target.squad.id}).`;
  return [
    `[NEXUS CRON · ${subject.name}]`,
    targetNote + directoryNote,
    '',
    subject.brief,
  ].join('\n');
}

function contractFor(
  subject: CronAuthoritySubject,
  target: ResolvedCronTarget,
  workingDirectory: string,
  approvedAt: number,
  deps: CronExecutionAuthorityDeps,
): MissionIntentContract {
  const squadSnapshot = snapshotSquadAuthority(target.squad);
  const orchestratorRuntime = canonicalMissionOrchestratorRuntime(
    deps.resolveRuntime(target.squad, target.orchestrator),
  );
  const base = compileIntentContract({
    goal: missionGoal(subject, target, workingDirectory),
    source: 'automation',
    intentVersion: 1,
    executionMode: 'autopilot',
    contextPolicy: 'on-demand',
    acceptanceCriteria: [
      `A agenda "${subject.name}" concluiu o brief autorizado com evidência verificável`,
      'Workers entregaram handoff e a missão terminou em done real ou blocked com CTA',
    ],
  });
  return missionIntentContractSchema.parse({
    ...base,
    approvedAt,
    squadRevisionHash: squadSnapshot.hash,
    orchestratorRuntime,
    ...(target.targetAgent &&
    target.targetAgent.category !== 'orchestrator'
      ? {
          requiredWorkerAgentRef: target.targetAgent.id,
          budgets: { ...base.budgets, maxWorkers: 1 },
        }
      : {}),
  });
}

function bindingHash(
  payload: string,
): string {
  return createHash('sha256').update(payload).digest('hex');
}

function bindingPayload(
  subject: CronAuthoritySubject,
  authority: Omit<
    CronExecutionAuthority,
    'jobBindingHash' | 'authorityTag'
  >,
): string {
  return canonicalJson({
    authority: {
      version: authority.version,
      origin: authority.origin,
      authorizedAt: authority.authorizedAt,
      consentReceiptId: authority.consentReceiptId,
      consentAction: authority.consentAction,
      scope: authority.scope,
      squadId: authority.squadId,
      targetAgentId: authority.targetAgentId ?? null,
      contract: authority.contract,
    },
    job: {
      id: subject.id,
      name: subject.name,
      schedule: subject.schedule,
      brief: subject.brief,
      status: subject.status,
      executionMode: subject.executionMode ?? 'shared',
      portableScheduleId: subject.portableScheduleId ?? null,
      definitionVersion: subject.definitionVersion ?? null,
      definitionHash: subject.definitionHash ?? null,
      workspacePath: subject.workspacePath ?? null,
      workingDirectory: subject.workingDirectory ?? null,
      projectId: subject.projectId ?? null,
      checkoutId: subject.checkoutId ?? null,
      agentName: subject.agentName ?? null,
      squadId: subject.squadId ?? null,
    },
  });
}

export function issueCronExecutionAuthority(
  subject: CronAuthoritySubject,
  rawScope: ProjectExecutionScope,
  consent: CronExactUserConsent,
  deps: CronExecutionAuthorityDeps = productionDeps,
): CronExecutionAuthority {
  const toolName = consent.toolName.replace(/^nexus_/, '').toLowerCase();
  if (consent.action !== 'create' && consent.action !== 'update') {
    throw new Error(
      'cron_exact_consent_required: recurring execution needs exact user consent',
    );
  }
  const consentAction = consent.action;
  if (
    toolName !== 'cron' ||
    !Number.isSafeInteger(consent.grantedAt) ||
    consent.grantedAt <= 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      consent.receiptId,
    )
  ) {
    throw new Error(
      'cron_exact_consent_required: recurring execution needs exact user consent',
    );
  }
  const scope = projectExecutionScopeSchema.parse(rawScope);
  const workingDirectory = resolvedWorkingDirectory(subject, scope);
  const target = resolveTargetForIssue(subject, deps);
  const contract = contractFor(
    subject,
    target,
    workingDirectory,
    consent.grantedAt,
    deps,
  );
  const material = {
    version: 2 as const,
    origin: 'nexus-cron-exact-consent' as const,
    authorizedAt: consent.grantedAt,
    consentReceiptId: consent.receiptId,
    consentAction,
    scope,
    squadId: target.squad.id,
    ...(target.targetAgent ? { targetAgentId: target.targetAgent.id } : {}),
    contract,
  };
  const payload = bindingPayload(subject, material);
  return cronExecutionAuthoritySchema.parse({
    ...material,
    jobBindingHash: bindingHash(payload),
    authorityTag: signCronAuthority(
      scope,
      {
        toolName: consent.toolName,
        action: consentAction,
        grantedAt: consent.grantedAt,
        receiptId: consent.receiptId,
      },
      payload,
    ),
  });
}

export function assertCronExecutionAuthority(
  subject: CronAuthoritySubject,
  rawScope: ProjectExecutionScope,
  deps: CronExecutionAuthorityDeps = productionDeps,
): CronExecutionAuthority {
  if (!subject.executionAuthority) {
    throw new Error(
      'cron_execution_authority_missing: job legado não autoriza execução; ' +
        'exclua e recrie a agenda para revisar o contrato recorrente',
    );
  }
  let authority: CronExecutionAuthority;
  try {
    authority = cronExecutionAuthoritySchema.parse(subject.executionAuthority);
  } catch (error) {
    throw new Error(
      'cron_execution_authority_invalid: stored recurring consent is invalid',
      { cause: error },
    );
  }
  const scope = projectExecutionScopeSchema.parse(rawScope);
  if (!sameScope(authority.scope, scope)) {
    throw new Error(
      'cron_execution_authority_stale: project/checkout authority changed; recreate the schedule',
    );
  }
  resolvedWorkingDirectory(subject, scope);
  const squad = deps.getSquad(authority.squadId);
  if (!squad) {
    throw new Error(
      'cron_execution_authority_stale: approved squad is unavailable',
    );
  }
  const orchestrator = requirePrimaryOrchestrator(squad);
  const targetAgent = subject.agentName
    ? squad.agents.filter(
        (agent) =>
          agent.id === subject.agentName ||
          agent.agentName === subject.agentName,
      )
    : [];
  if (
    subject.squadId !== undefined
      ? subject.squadId !== squad.id || authority.targetAgentId !== undefined
      : targetAgent.length !== 1 ||
        authority.targetAgentId !== targetAgent[0]?.id
  ) {
    throw new Error(
      'cron_execution_authority_stale: approved target no longer matches the job',
    );
  }
  const snapshot = snapshotSquadAuthority(squad);
  if (authority.contract.squadRevisionHash !== snapshot.hash) {
    throw new Error(
      'cron_execution_authority_stale: approved squad roster changed; recreate the schedule',
    );
  }
  const runtime = canonicalMissionOrchestratorRuntime(
    deps.resolveRuntime(squad, orchestrator),
  );
  if (
    !sameMissionOrchestratorRuntime(
      authority.contract.orchestratorRuntime,
      runtime,
    )
  ) {
    throw new Error(
      'cron_execution_authority_stale: approved orchestrator runtime changed; recreate the schedule',
    );
  }
  if (
    authority.contract.approvedAt !== authority.authorizedAt ||
    authority.contract.intentVersion !== 1 ||
    authority.contract.source !== 'automation'
  ) {
    throw new Error(
      'cron_execution_authority_invalid: approved contract is inconsistent',
    );
  }
  const { jobBindingHash, authorityTag, ...material } = authority;
  const payload = bindingPayload(subject, material);
  if (bindingHash(payload) !== jobBindingHash) {
    throw new Error(
      'cron_execution_authority_stale: job identity or definition changed without reapproval; recreate the schedule',
    );
  }
  if (!verifyCronAuthority(payload, authorityTag)) {
    throw new Error(
      'cron_execution_authority_invalid: authenticated recurring consent could not be verified',
    );
  }
  return authority;
}
