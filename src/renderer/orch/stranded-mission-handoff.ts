/**
 * Operator recovery when failover cannot switch accounts: a 401'd mission
 * pane plus "+ Pane" with a working account. Continuity is injected as a
 * fresh-session prompt — the new pane must NOT carry missionId (Main would
 * reject it as stale persisted authority).
 */

import { buildContinuityPack } from './failover-continuity';

const pendingContinuity = new Map<string, string>();

export function stashPendingContinuity(paneId: string, pack: string): void {
  pendingContinuity.set(paneId, pack);
}

export function takePendingContinuity(paneId: string): string | undefined {
  const pack = pendingContinuity.get(paneId);
  if (pack === undefined) return undefined;
  pendingContinuity.delete(paneId);
  return pack;
}

/** Claude/Codex client retry ticker and login screens cannot take a prompt. */
export function cliAcceptsContinuityPrompt(recentOutput: string): boolean {
  const text = recentOutput.replace(/\x1b\[[0-9;]*m/g, '');
  if (/please run \/login/i.test(text)) return false;
  if (/oauth access token has expired/i.test(text)) return false;
  if (/re-authenticate to continue/i.test(text)) return false;
  if (/not logged in/i.test(text) && /\/login/i.test(text)) return false;
  if (
    /\bretrying\s+in\s+\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?)\s*[·|•\-]\s*attempt\s+\d+\s*\/\s*\d+/i.test(
      text,
    )
  ) {
    return false;
  }
  return true;
}

export function nextContinuityInjectionDelay(input: {
  readonly attempt: number;
  readonly cliReady: boolean;
}): { action: 'inject' } | { action: 'wait'; waitMs: number } | { action: 'abandon' } {
  if (input.cliReady) return { action: 'inject' };
  if (input.attempt >= 7) return { action: 'abandon' };
  return { action: 'wait', waitMs: 1_000 };
}

export interface StrandedPane {
  readonly id: string;
  readonly kind?: string;
  readonly missionId?: string;
  readonly adapterId?: string;
  readonly role?: 'orchestrator' | 'worker';
  readonly accountId?: string;
}

export interface StrandedMissionHandoff {
  readonly missionId: string;
  readonly fromPaneId: string;
  readonly role?: 'orchestrator' | 'worker';
}

function paneMissionId(
  pane: StrandedPane,
  paneMissions: Readonly<Record<string, string>>,
): string | undefined {
  return pane.missionId ?? paneMissions[pane.id];
}

function isOpenMission(
  missionId: string,
  missions: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  const mission = missions.find((candidate) => candidate.id === missionId);
  return mission?.status === 'running' || mission?.status === 'blocked';
}

function isStrandedPane(
  pane: StrandedPane,
  paneMissions: Readonly<Record<string, string>>,
  paneStates: Readonly<Record<string, string | undefined>>,
  recentOutputByPane: Readonly<Record<string, string>>,
  missions: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  if (pane.kind !== 'cli-agent') return false;
  const missionId = paneMissionId(pane, paneMissions);
  if (!missionId || !isOpenMission(missionId, missions)) return false;
  const state = paneStates[pane.id];
  if (state === 'exited' || state === 'hibernated') return true;
  const output = recentOutputByPane[pane.id] ?? '';
  return output.length > 0 && !cliAcceptsContinuityPrompt(output);
}

export function resolveStrandedMissionHandoff(input: {
  readonly focusedPaneId: string | null;
  readonly panes: readonly StrandedPane[];
  readonly paneMissions: Readonly<Record<string, string>>;
  readonly paneStates: Readonly<Record<string, string | undefined>>;
  readonly recentOutputByPane: Readonly<Record<string, string>>;
  readonly missions: ReadonlyArray<{ id: string; status: string }>;
}): StrandedMissionHandoff | null {
  const focused = input.panes.find((pane) => pane.id === input.focusedPaneId);
  if (focused?.kind === 'cli-agent') {
    const missionId = paneMissionId(focused, input.paneMissions);
    if (
      missionId &&
      isOpenMission(missionId, input.missions) &&
      !isStrandedPane(
        focused,
        input.paneMissions,
        input.paneStates,
        input.recentOutputByPane,
        input.missions,
      )
    ) {
      // Operador quer um segundo agente ao lado de um que ainda trabalha.
      return null;
    }
  }

  const stranded = input.panes.filter((pane) =>
    isStrandedPane(
      pane,
      input.paneMissions,
      input.paneStates,
      input.recentOutputByPane,
      input.missions,
    ),
  );
  if (stranded.length === 0) return null;
  const preferred =
    stranded.find((pane) => pane.id === input.focusedPaneId) ??
    stranded.find((pane) => pane.role === 'orchestrator') ??
    stranded[0];
  if (!preferred) return null;
  const missionId = paneMissionId(preferred, input.paneMissions);
  if (!missionId) return null;
  return {
    missionId,
    fromPaneId: preferred.id,
    ...(preferred.role ? { role: preferred.role } : {}),
  };
}

export function planOperatorAgentSpawn(input: {
  readonly accountId?: string;
  readonly focusedPaneId: string | null;
  readonly panes: readonly StrandedPane[];
  readonly paneMissions: Readonly<Record<string, string>>;
  readonly paneStates: Readonly<Record<string, string | undefined>>;
  readonly recentOutputByPane: Readonly<Record<string, string>>;
  readonly missions: ReadonlyArray<{ id: string; title?: string; status: string }>;
  readonly fromAccountLabel: string;
  readonly toAccountLabel: string;
}): { accountId?: string; continuityPack?: string } {
  const handoff = resolveStrandedMissionHandoff(input);
  const options: { accountId?: string; continuityPack?: string } = {};
  if (input.accountId) options.accountId = input.accountId;
  if (!handoff) return options;
  const mission = input.missions.find((candidate) => candidate.id === handoff.missionId);
  options.continuityPack = buildContinuityPack({
    fromAccountLabel: input.fromAccountLabel,
    toAccountLabel: input.toAccountLabel,
    reason: 'sessão expirada (401 OAuth)',
    role: handoff.role,
    missionId: handoff.missionId,
    openWorkHint: mission
      ? `${mission.id}${mission.title ? `: ${mission.title}` : ''}`
      : handoff.missionId,
    scrollbackExcerpt: input.recentOutputByPane[handoff.fromPaneId],
  });
  return options;
}
