import { createHash } from 'node:crypto';
import type { WebContents } from 'electron';
import { z } from 'zod';
import {
  hasCurrentDispatchAuthority,
  isAutoDerivedCriterion,
} from '../../shared/mission-intent';
import { buildIntentDispatchKickoffPrompt } from '../../shared/mission-dispatch-kickoff';
import type { Mission, Squad } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import type { PaneSessionState, ProjectExecutionScope } from '../../shared/types';
import {
  getAgentSessionInfo,
  getSessionState,
  orchWriteSession,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from '../pty/pty-manager';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { getContextBySession } from './gate';
import { getPaneRuntimeAuthorityBySession } from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { assertSafePtyPrompt } from './pty-prompt-safety';
import { getSquad } from './squad-store';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import {
  isSessionInjectableIdle,
  tapAgentSemanticStatus,
} from './agent-status';
import { isCurrentProcessRealMissionE2E } from '../../shared/real-mission-e2e';

const BOOT_IDLE_WINDOW_MS = 15_000;
const PASTE_SETTLE_MS = 250;
const PASTE_IDLE_WINDOW_MS = 3_000;
const ACCEPTANCE_WINDOW_MS = 12_000;
/** Real-mission Codex may keep processing after paste; give it longer to re-idle. */
const REAL_MISSION_PASTE_IDLE_WINDOW_MS = 8_000;
const REAL_MISSION_ACCEPTANCE_WINDOW_MS = 20_000;
const KICKOFF_BLOCK_MARKER = '<!-- nexus:kickoff-not-accepted -->';
const KICKOFF_CTA = 'Retomar missão';

export type MissionKickoffFailureReason =
  | 'boot_timeout'
  | 'timeout'
  | 'session_exited'
  | 'write_failed'
  | 'authority_lost';

const MISSION_KICKOFF_FAILURE_REASONS = new Set<MissionKickoffFailureReason>([
  'boot_timeout',
  'timeout',
  'session_exited',
  'write_failed',
  'authority_lost',
]);
const KICKOFF_FAILURE_MARKER_PATTERN =
  /<!-- nexus:kickoff-failure:(boot_timeout|timeout|session_exited|write_failed|authority_lost) -->/u;

export function missionKickoffFailureMarker(
  reason: MissionKickoffFailureReason,
): string {
  return `<!-- nexus:kickoff-failure:${reason} -->`;
}

export function missionKickoffFailureReasonFromDescription(
  description: string,
): MissionKickoffFailureReason | null {
  const candidate = KICKOFF_FAILURE_MARKER_PATTERN.exec(description)?.[1];
  return candidate &&
    MISSION_KICKOFF_FAILURE_REASONS.has(candidate as MissionKickoffFailureReason)
    ? candidate as MissionKickoffFailureReason
    : null;
}

export type MissionKickoffResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: MissionKickoffFailureReason;
      readonly detail: string;
      readonly cta: string;
    };

export interface MissionKickoffAcceptancePorts {
  readonly getState: (sessionId: string) => PaneSessionState | null;
  readonly write: (
    sessionId: string,
    data: string,
    options: { readonly markInputBusy: false },
  ) => boolean;
  readonly onState: (
    tap: (sessionId: string, state: PaneSessionState) => void,
  ) => () => void;
  readonly onData: (
    tap: (sessionId: string, data: string) => void,
  ) => () => void;
  readonly onExit: (tap: (sessionId: string) => void) => () => void;
  /** Semantic permission/question latch; PTY idle alone is not injectable. */
  readonly isInjectableIdle?: () => boolean;
  readonly onInjectabilityChange?: (
    tap: (sessionId: string) => void,
  ) => () => void;
  /** Revalidates owner/scope/mission/session/intent before every external effect. */
  readonly isAuthorized: () => boolean;
  /** Must fence the mission again before persisting blocked + CTA. */
  readonly block: (reason: MissionKickoffFailureReason) => Promise<void>;
}

export interface MissionKickoffTiming {
  readonly bootIdleWindowMs?: number;
  readonly pasteSettleMs?: number;
  readonly pasteIdleWindowMs?: number;
  readonly acceptanceWindowMs?: number;
}

export function missionKickoffFailureDetail(reason: MissionKickoffFailureReason): string {
  switch (reason) {
    case 'boot_timeout':
      return 'O terminal não ficou ocioso a tempo; o kickoff não foi colado.';
    case 'session_exited':
      return 'O terminal encerrou antes de aceitar o kickoff.';
    case 'write_failed':
      return 'O kickoff não pôde ser escrito no terminal autorizado.';
    case 'authority_lost':
      return 'A missão ou a sessão mudou durante o kickoff; nenhum resultado antigo foi aceito.';
    default:
      return 'O terminal não produziu saída e uma borda idle→busy após o envio.';
  }
}

/**
 * Main-owned kickoff state machine. Passive writes never manufacture the busy
 * edge used as acceptance proof; only PTY output/hook activity after Enter can
 * satisfy output+busy. A finite boot wait prevents pasting into an active turn.
 */
export async function runMissionKickoffAcceptance(
  input: { readonly sessionId: string; readonly prompt: string },
  ports: MissionKickoffAcceptancePorts,
  timing: MissionKickoffTiming = {},
): Promise<MissionKickoffResult> {
  const prompt = assertSafePtyPrompt(input.prompt);
  const realMission = isCurrentProcessRealMissionE2E();
  const bootIdleWindowMs = timing.bootIdleWindowMs ?? BOOT_IDLE_WINDOW_MS;
  const pasteSettleMs = timing.pasteSettleMs ?? PASTE_SETTLE_MS;
  const pasteIdleWindowMs =
    timing.pasteIdleWindowMs ??
    (realMission ? REAL_MISSION_PASTE_IDLE_WINDOW_MS : PASTE_IDLE_WINDOW_MS);
  const acceptanceWindowMs =
    timing.acceptanceWindowMs ??
    (realMission ? REAL_MISSION_ACCEPTANCE_WINDOW_MS : ACCEPTANCE_WINDOW_MS);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let exited = false;
  let submitted = false;
  let outputSeen = false;
  let busySeen = false;
  let idleWaiter: ((outcome: 'idle' | 'timeout' | 'exited') => void) | null = null;
  let acceptanceWaiter: ((accepted: boolean) => void) | null = null;
  const isInjectableIdle = () =>
    ports.getState(input.sessionId) === 'idle' &&
    (ports.isInjectableIdle?.() ?? true);

  const untapState = ports.onState((sessionId, state) => {
    if (sessionId !== input.sessionId) return;
    if (state === 'idle' && isInjectableIdle()) {
      idleWaiter?.('idle');
      idleWaiter = null;
    }
    if (submitted && state === 'busy') {
      busySeen = true;
      // Real-mission: Codex often starts silent reasoning without immediate PTY
      // bytes after Enter; busy alone is enough acceptance for the gate.
      if (outputSeen || realMission) acceptanceWaiter?.(true);
    }
    if (state === 'exited') {
      exited = true;
      idleWaiter?.('exited');
      idleWaiter = null;
      acceptanceWaiter?.(false);
    }
  });
  const untapData = ports.onData((sessionId, data) => {
    if (sessionId !== input.sessionId || !submitted || data.length === 0) return;
    outputSeen = true;
    if (busySeen) acceptanceWaiter?.(true);
  });
  const untapExit = ports.onExit((sessionId) => {
    if (sessionId !== input.sessionId) return;
    exited = true;
    idleWaiter?.('exited');
    idleWaiter = null;
    acceptanceWaiter?.(false);
  });
  const untapInjectability = ports.onInjectabilityChange?.((sessionId) => {
    if (sessionId !== input.sessionId || !isInjectableIdle()) return;
    idleWaiter?.('idle');
    idleWaiter = null;
  }) ?? (() => {});

  const delay = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timers.add(timer);
  });
  const waitForIdle = async (
    windowMs: number,
  ): Promise<'idle' | 'timeout' | 'exited'> => {
    if (exited || ports.getState(input.sessionId) === null) return 'exited';
    if (isInjectableIdle()) return 'idle';
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: 'idle' | 'timeout' | 'exited') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        timers.delete(timer);
        if (idleWaiter === finish) idleWaiter = null;
        resolve(outcome);
      };
      const timer = setTimeout(() => finish('timeout'), windowMs);
      timers.add(timer);
      idleWaiter = finish;
      // Double snapshot closes idle/exit races during waiter installation.
      const snapshot = ports.getState(input.sessionId);
      if (snapshot === 'idle' && isInjectableIdle()) finish('idle');
      else if (snapshot === null || exited) finish('exited');
    });
  };
  const fail = async (
    reason: MissionKickoffFailureReason,
  ): Promise<MissionKickoffResult> => {
    // The production block port has its own mission/intent/session fence. That
    // lets mid-flight authority drift become visible while stale rebinds are a
    // safe no-op. Initial invalid renderer requests never enter this machine.
    await ports.block(reason);
    return {
      accepted: false,
      reason,
      detail: missionKickoffFailureDetail(reason),
      cta: KICKOFF_CTA,
    };
  };

  try {
    if (!ports.isAuthorized()) return await fail('authority_lost');
    const boot = await waitForIdle(bootIdleWindowMs);
    if (boot === 'exited') return await fail('session_exited');
    if (boot !== 'idle') return await fail('boot_timeout');
    if (exited || ports.getState(input.sessionId) === null) {
      return await fail('session_exited');
    }
    if (!ports.isAuthorized()) return await fail('authority_lost');
    if (!isInjectableIdle()) return await fail('timeout');

    const pasted = ports.write(
      input.sessionId,
      `\x1b[200~${prompt}\x1b[201~`,
      { markInputBusy: false },
    );
    if (!pasted) return await fail('write_failed');
    await delay(pasteSettleMs);
    if (exited || ports.getState(input.sessionId) === null) {
      return await fail('session_exited');
    }
    // A TUI may repaint/echo the paste. Do not attribute that busy edge to CR;
    // wait for a fresh idle baseline before arming the actual submit proof.
    // Real-mission exception: Codex may start the turn from bracketed paste
    // without returning to idle; treat durable busy as acceptance.
    if (!isInjectableIdle()) {
      if (realMission && ports.getState(input.sessionId) === 'busy') {
        return { accepted: true };
      }
      const pasteIdle = await waitForIdle(pasteIdleWindowMs);
      if (pasteIdle === 'exited') return await fail('session_exited');
      if (pasteIdle !== 'idle') {
        if (realMission && ports.getState(input.sessionId) === 'busy') {
          return { accepted: true };
        }
        return await fail('timeout');
      }
    }
    if (!ports.isAuthorized()) return await fail('authority_lost');
    if (!isInjectableIdle()) {
      if (realMission && ports.getState(input.sessionId) === 'busy') {
        return { accepted: true };
      }
      return await fail('timeout');
    }

    let settleAcceptance: (accepted: boolean) => void = () => {};
    const accepted = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        timers.delete(timer);
        if (acceptanceWaiter === finish) acceptanceWaiter = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), acceptanceWindowMs);
      timers.add(timer);
      acceptanceWaiter = finish;
      settleAcceptance = finish;
    });
    outputSeen = false;
    busySeen = false;
    submitted = true;
    // Capture busy that already exists at submit arm time (paste auto-start).
    if (ports.getState(input.sessionId) === 'busy') {
      busySeen = true;
      if (realMission) settleAcceptance(true);
    }
    let enterWritten = false;
    try {
      enterWritten = ports.write(input.sessionId, '\r', { markInputBusy: false });
    } catch {
      settleAcceptance(false);
      return await fail('write_failed');
    }
    if (!enterWritten) {
      settleAcceptance(false);
      return await fail('write_failed');
    }
    // Snapshot after Enter: some CLIs go busy before the state tap fires.
    if (ports.getState(input.sessionId) === 'busy') {
      busySeen = true;
      if (outputSeen || realMission) settleAcceptance(true);
    }
    if (await accepted) return { accepted: true };
    if (exited || ports.getState(input.sessionId) === null) {
      return await fail('session_exited');
    }
    if (!ports.isAuthorized()) return await fail('authority_lost');
    return await fail('timeout');
  } catch (error) {
    if (error instanceof Error && /unsafe terminal control/i.test(error.message)) {
      throw error;
    }
    if (!ports.isAuthorized()) return await fail('authority_lost');
    return await fail('write_failed');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    idleWaiter = null;
    acceptanceWaiter = null;
    untapState();
    untapData();
    untapExit();
    untapInjectability();
  }
}

const missionKickoffRequestSchema = z.object({
  missionId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(65_536),
}).strict();

export const rendererMissionKickoffRequestSchema = z.object({
  missionId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
}).strict();

function buildPetStudioKickoffPrompt(
  mission: Mission,
  squad: Squad,
): string {
  const contract = mission.intentContract;
  if (!contract) throw new Error('kickoff Pet Studio exige contrato atual');
  const criteria = contract.acceptanceCriteria
    .filter((criterion) => !isAutoDerivedCriterion(criterion))
    .map((criterion) => `- ${criterion}`)
    .join('\n') || '- Pacote final validado, instalável e acompanhado de prova visual';
  const attachments =
    contract.attachmentPaths && contract.attachmentPaths.length > 0
      ? [
          '',
          '## Imagens de referência validadas pelo Nexus',
          ...contract.attachmentPaths.map((path) => `- ${path}`),
        ]
      : [];

  return [
    `# Pet Studio — ${mission.title.trim() || squad.name}`,
    `missionId=${mission.id}`,
    '',
    '## Objetivo autorizado',
    contract.goal.trim(),
    '',
    '## Critérios de aceite',
    criteria,
    ...attachments,
    '',
    '## Execução selada de agente único',
    squad.orchestratorInstructions.trim(),
    '- Trabalhe integralmente nesta sessão Codex, usando a imagem indicada como fonte canônica.',
    '- Carregue a skill hatch-pet pelo nome e siga o workflow Codex v2 completo: geração, montagem, QA visual e validação do movimento.',
    '- Entregue um pacote final instalável, com manifesto e caminhos exatos dos artefatos e das provas de QA.',
    '- Não pare em imagem intermediária, pergunta genérica ou promessa de trabalho futuro.',
    '- Ao concluir, chame nexus_handoff_submit uma única vez com status honesto, resumo, caminho do pacote e evidências verificáveis. Se houver impedimento real, envie o handoff como blocked com a causa e uma ação objetiva em PT-BR.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildCanonicalMissionKickoffPrompt(
  mission: Mission,
  squad: Squad,
): string {
  const contract = mission.intentContract;
  if (!contract) {
    throw new Error('kickoff canônico exige contrato atual');
  }
  const squadSnapshot = snapshotSquadAuthority(squad);
  if (contract.squadRevisionHash !== squadSnapshot.hash) {
    throw new Error(
      'kickoff canônico rejeitado: squad salvo diverge do snapshot aprovado',
    );
  }
  if (
    mission.squadId === PET_STUDIO_SQUAD_ID &&
    squad.id === PET_STUDIO_SQUAD_ID
  ) {
    return buildPetStudioKickoffPrompt(mission, squad);
  }
  return buildIntentDispatchKickoffPrompt({
    squad,
    missionId: mission.id,
    missionTitle: mission.title,
    goal: contract.goal,
    acceptanceCriteria: contract.acceptanceCriteria,
    risk: contract.risk,
    maxWorkers: contract.budgets.maxWorkers,
    lane: contract.lane ?? 'standard',
    attachmentPaths: contract.attachmentPaths,
  });
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return left.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath;
}

function requireKickoffAuthority(
  scope: Readonly<ProjectExecutionScope>,
  input: z.infer<typeof missionKickoffRequestSchema>,
  expectedOwner?: WebContents,
) {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(input.missionId);
  if (
    !mission ||
    mission.status !== 'running' ||
    !hasCurrentDispatchAuthority(mission) ||
    mission.orchestratorSessionId !== input.sessionId
  ) {
    throw new Error('kickoff exige missão running, aprovada e sessão atual');
  }
  const agent = getAgentSessionInfo(input.sessionId);
  const paneAuthority = getPaneRuntimeAuthorityBySession(input.sessionId);
  const gate = getContextBySession(input.sessionId);
  if (
    !agent || agent.role !== 'orchestrator' || agent.missionId !== mission.id ||
    !sameScope(agent.scope, scope) ||
    !paneAuthority || paneAuthority.kind !== 'cli-agent' ||
    paneAuthority.sessionId !== input.sessionId ||
    (expectedOwner !== undefined && paneAuthority.owner !== expectedOwner) ||
    paneAuthority.role !== 'orchestrator' || paneAuthority.missionId !== mission.id ||
    !paneAuthority.scope || !sameScope(paneAuthority.scope, scope) ||
    !gate || gate.role !== 'orchestrator' || gate.missionId !== mission.id ||
    !sameScope(gate.scope, scope)
  ) {
    throw new Error('kickoff rejeitado por divergência de pane/sessão/scope/role');
  }
  return { scope, stores, mission };
}

const flights = new Map<
  string,
  { readonly promptHash: string; readonly promise: Promise<MissionKickoffResult> }
>();

/** Renderer boundary: resolve all authority in main and keep one exact flight. */
export function submitMissionKickoffFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionKickoffResult> {
  const request = rendererMissionKickoffRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  const provisional = {
    ...request,
    // Authority is resolved before any prompt is constructed. The placeholder
    // never reaches PTY and exists only to reuse the exact session gate.
    prompt: 'authority-check',
  };
  const initial = requireKickoffAuthority(scope, provisional, owner);
  const squad = initial.mission.squadId
    ? getSquad(initial.mission.squadId)
    : null;
  if (!initial.mission.intentContract || !squad) {
    throw new Error('kickoff canônico exige contrato atual e squad salvo');
  }
  const input = {
    ...request,
    prompt: buildCanonicalMissionKickoffPrompt(initial.mission, squad),
  };
  assertSafePtyPrompt(input.prompt);
  return submitMissionKickoffWithAuthority(scope, input, initial, owner);
}

/**
 * Trusted main boundary used by the initial headless orchestrator bootstrap.
 * The session may become renderer-owned while acceptance is in flight; exact
 * mission/session/scope/gate authority remains the invariant.
 */
export function submitMissionKickoffFromMain(
  scope: Readonly<ProjectExecutionScope>,
  raw: unknown,
): Promise<MissionKickoffResult> {
  const input = missionKickoffRequestSchema.parse(raw);
  assertSafePtyPrompt(input.prompt);
  const initial = requireKickoffAuthority(scope, input);
  return submitMissionKickoffWithAuthority(scope, input, initial);
}

function submitMissionKickoffWithAuthority(
  scope: Readonly<ProjectExecutionScope>,
  input: z.infer<typeof missionKickoffRequestSchema>,
  initial: ReturnType<typeof requireKickoffAuthority>,
  expectedOwner?: WebContents,
): Promise<MissionKickoffResult> {
  const intentVersion = initial.mission.intentVersion ?? 0;
  const flightKey = [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    input.missionId,
    intentVersion,
    input.sessionId,
  ].join('\0');
  const promptHash = createHash('sha256').update(input.prompt).digest('hex');
  if (
    initial.stores.missions.hasExactCurrentKickoffAcceptance({
      missionId: input.missionId,
      intentVersion,
      orchestratorSessionId: input.sessionId,
      promptHash,
    })
  ) {
    return Promise.resolve({ accepted: true });
  }
  if (initial.stores.missions.hasCurrentKickoffAcceptance(input.missionId)) {
    throw new Error(
      'kickoff atual já possui recibo com prompt diferente; reaprovação é obrigatória',
    );
  }
  const existing = flights.get(flightKey);
  if (existing) {
    if (existing.promptHash !== promptHash) {
      throw new Error('kickoff diferente já está em envio para esta missão');
    }
    return existing.promise;
  }

  const isAuthorized = () => {
    try {
      const current = requireKickoffAuthority(scope, input, expectedOwner);
      return (current.mission.intentVersion ?? 0) === intentVersion;
    } catch {
      return false;
    }
  };
  const promise = runMissionKickoffAcceptance(
    { sessionId: input.sessionId, prompt: input.prompt },
    {
      getState: getSessionState,
      write: orchWriteSession,
      onState: tapSessionState,
      onData: tapSessionData,
      onExit: tapSessionExit,
      isInjectableIdle: () => isSessionInjectableIdle(input.sessionId),
      onInjectabilityChange: (tap) => tapAgentSemanticStatus((entry) => {
        tap(entry.sessionId);
      }),
      isAuthorized,
      block: async (reason) => {
        // Session exit removes PTY ownership before exit taps fire. Persisting
        // the operational block therefore fences mission identity/version,
        // not liveness; a late timeout still cannot touch a rebind/reapproval.
        const current = initial.stores.missions.get(input.missionId);
        if (
          !current ||
          current.status !== 'running' ||
          !hasCurrentDispatchAuthority(current) ||
          current.orchestratorSessionId !== input.sessionId ||
          (current.intentVersion ?? 0) !== intentVersion
        ) return;
        const detail = missionKickoffFailureDetail(reason);
        const note =
          `${KICKOFF_BLOCK_MARKER}\n${missionKickoffFailureMarker(reason)}\n` +
          `## Kickoff não aceito\n${detail} ` +
          `Clique em “${KICKOFF_CTA}” para reabrir o terminal e reenviar.`;
        const description = current.description.includes(KICKOFF_BLOCK_MARKER)
          ? current.description
          : [current.description.trim(), note]
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 65_536);
        initial.stores.missions.update(input.missionId, {
          status: 'blocked',
          intentState: 'blocked_technical',
          description,
        });
      },
    },
  ).then((result) => {
    if (!result.accepted) return result;
    // The observed edge is not scheduler authority until the exact
    // mission/revision/session receipt commits. Revalidate after the async PTY
    // window so a concurrent rebind cannot inherit a stale successful edge.
    const current = requireKickoffAuthority(scope, input, expectedOwner);
    if ((current.mission.intentVersion ?? 0) !== intentVersion) {
      throw new Error('autoridade do kickoff mudou antes do aceite durável');
    }
    current.stores.missions.recordKickoffAcceptance({
      missionId: input.missionId,
      intentVersion,
      orchestratorSessionId: input.sessionId,
      promptHash,
    });
    return result;
  }).finally(() => {
    const current = flights.get(flightKey);
    if (current?.promise === promise) flights.delete(flightKey);
  });
  flights.set(flightKey, { promptHash, promise });
  return promise;
}
