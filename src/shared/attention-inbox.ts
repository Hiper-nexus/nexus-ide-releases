export type AttentionKind =
  | 'enter'
  | 'pr-queue'
  | 'mission-stuck'
  | 'cli-login';

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  /** Pane / mission / provider / PR number — used by the UI to jump. */
  targetId: string;
};

export type AttentionInboxInput = {
  notifications: ReadonlyArray<{
    paneId: string;
    agentLabel: string;
    kind: 'completed' | 'needs_input' | 'exited';
  }>;
  /**
   * Live hook latches (permission / waiting). When present, this is the
   * source of truth for "pede Enter" — historical needs_input notifications
   * are ignored so ⌘J does not keep a lie after the agent continues.
   */
  waitingAgents?: ReadonlyArray<{
    paneId: string;
    agentLabel: string;
  }>;
  pr: {
    number: number;
    title: string;
    autoMergeEnabled: boolean;
    mergeQueueRequired: boolean | null;
  } | null;
  missions: ReadonlyArray<{
    id: string;
    title: string;
    needsAttention: boolean;
  }>;
  providers: ReadonlyArray<{
    adapterId: string;
    label: string;
    enabled: boolean;
    installed: boolean;
    authStrategy: string;
  }>;
};

export function collectAttentionItems(
  input: AttentionInboxInput,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const enterSources =
    input.waitingAgents !== undefined
      ? input.waitingAgents
      : input.notifications
          .filter((n) => n.kind === 'needs_input')
          .map((n) => ({ paneId: n.paneId, agentLabel: n.agentLabel }));
  for (const n of enterSources) {
    items.push({
      id: `enter:${n.paneId}`,
      kind: 'enter',
      title: `${n.agentLabel} pede Enter`,
      detail: 'O agente está esperando você confirmar no terminal.',
      targetId: n.paneId,
    });
  }
  const pr = input.pr;
  if (pr && (pr.autoMergeEnabled || pr.mergeQueueRequired === true)) {
    items.push({
      id: `pr:${pr.number}`,
      kind: 'pr-queue',
      title: pr.autoMergeEnabled
        ? `PR #${pr.number} na fila`
        : `PR #${pr.number} pode entrar na fila`,
      detail: pr.title,
      targetId: String(pr.number),
    });
  }
  for (const mission of input.missions) {
    if (!mission.needsAttention) continue;
    items.push({
      id: `mission:${mission.id}`,
      kind: 'mission-stuck',
      title: `Missão travada: ${mission.title}`,
      detail: 'A missão precisa da sua decisão para continuar.',
      targetId: mission.id,
    });
  }
  for (const provider of input.providers) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.authStrategy !== 'login-needed'
    ) {
      continue;
    }
    items.push({
      id: `cli:${provider.adapterId}`,
      kind: 'cli-login',
      title: `${provider.label} sem login`,
      detail: 'Entre na CLI para os agentes desta conta funcionarem.',
      targetId: provider.adapterId,
    });
  }
  return items;
}
