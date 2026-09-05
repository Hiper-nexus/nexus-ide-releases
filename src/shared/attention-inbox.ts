import { missionChromeTitle } from './mission-identity';

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
  /** Botão: diz a CLI/ação, não um "Ir" genérico. */
  actionLabel: string;
};

export function attentionKindBadge(kind: AttentionKind): string {
  if (kind === 'cli-login') return 'Login';
  if (kind === 'enter') return 'Enter';
  if (kind === 'mission-stuck') return 'Missão';
  return 'PR';
}

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
    authState?: 'ok' | 'missing' | 'unknown';
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
      title: n.agentLabel,
      detail: `${n.agentLabel} está esperando você confirmar no terminal (Enter).`,
      targetId: n.paneId,
      actionLabel: `Ir ao pane de ${n.agentLabel}`,
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
      actionLabel: `Abrir PR #${pr.number}`,
    });
  }
  for (const mission of input.missions) {
    if (!mission.needsAttention) continue;
    const chromeTitle = missionChromeTitle(mission.title);
    items.push({
      id: `mission:${mission.id}`,
      kind: 'mission-stuck',
      title: chromeTitle,
      detail: `A missão "${chromeTitle}" precisa da sua decisão para continuar.`,
      targetId: mission.id,
      actionLabel: 'Abrir missão',
    });
  }
  for (const provider of input.providers) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.authStrategy !== 'login-needed' ||
      (provider.authState !== undefined && provider.authState !== 'missing')
    ) {
      continue;
    }
    items.push({
      id: `cli:${provider.adapterId}`,
      kind: 'cli-login',
      title: provider.label,
      detail: `${provider.label} precisa do seu login. Sem isso os agentes desta CLI não sobem.`,
      targetId: provider.adapterId,
      actionLabel: `Entrar no ${provider.label}`,
    });
  }
  return items;
}
