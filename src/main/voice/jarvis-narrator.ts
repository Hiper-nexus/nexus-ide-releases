import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from '../orch/project-domain-store-registry';
import { getVoiceConfig } from './voice-config-store';
import { toSpeakable } from './speakable';

const BURST_MS = 1_500;
const MAX_SPOKEN_SUMMARY = 140;
const BOOT_GRACE_MS = 6_000;

export type ScopedNarrationBroadcast = (
  scope: ProjectExecutionScope,
  channel: string,
  payload?: unknown,
) => void;

export interface NarratorHandoffSource {
  onChange(listener: (scope: ProjectExecutionScope) => void): () => void;
  list(scope: ProjectExecutionScope): readonly Handoff[];
}

interface PendingNarration {
  handoff: Handoff;
  scope: ProjectExecutionScope;
}

const seen = new Set<string>();
let pending: PendingNarration[] = [];
let burstTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let startedAt = 0;

function defaultSource(): NarratorHandoffSource {
  const registry = requireProjectDomainStoreRegistry();
  return {
    onChange(listener) {
      return registry.onChange((scope, store) => {
        if (store === 'handoffs') listener(scope);
      });
    },
    list(scope) {
      return getProjectDomainStores(scope).handoffs.list({ includeDelivered: true });
    },
  };
}

function handoffKey(scope: ProjectExecutionScope, handoff: Handoff): string {
  return `${scope.projectId}\0${scope.checkoutId}\0${handoff.id}`;
}

function phraseFor(handoff: Handoff): string {
  const from = (handoff.fromAgent ?? 'um worker').slice(0, 60);
  const short = toSpeakable(handoff.summary, 'summary').slice(0, MAX_SPOKEN_SUMMARY);
  switch (handoff.status) {
    case 'stalled':
      return `Atenção: ${from} parece travado. ${short}`;
    case 'failed':
      return `${from} falhou na tarefa. ${short}`;
    case 'blocked':
      return `${from} está bloqueado e precisa de você. ${short}`;
    case 'partial':
      return `${from} entregou parcialmente: ${short}`;
    default:
      return `${from} entregou: ${short}`;
  }
}

function sameScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.projectId === right.projectId && left.checkoutId === right.checkoutId
  );
}

function flush(broadcast: ScopedNarrationBroadcast): void {
  burstTimer = null;
  const batch = pending;
  pending = [];
  while (batch.length > 0) {
    const first = batch.shift()!;
    const sameProject = [
      first,
      ...batch.filter((item) => sameScope(item.scope, first.scope)),
    ];
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      if (sameScope(batch[index].scope, first.scope)) batch.splice(index, 1);
    }
    const text =
      sameProject.length === 1
        ? phraseFor(first.handoff)
        : `${sameProject.length} atualizações do squad. ${sameProject
            .map((item) => phraseFor(item.handoff))
            .join(' ')}`.slice(0, 400);
    broadcast(first.scope, 'voice:narrate', {
      text,
      eventId: sameProject.map((item) => item.handoff.id).join(','),
      ...(first.handoff.missionId ? { missionId: first.handoff.missionId } : {}),
      ...(first.handoff.sessionId ? { paneId: first.handoff.sessionId } : {}),
    });
  }
}

function onChange(
  scope: ProjectExecutionScope,
  broadcast: ScopedNarrationBroadcast,
  source: NarratorHandoffSource,
): void {
  const jarvis = getVoiceConfig().routing === 'jarvis';
  const withinBootGrace = Date.now() - startedAt < BOOT_GRACE_MS;
  for (const handoff of source.list(scope)) {
    const key = handoffKey(scope, handoff);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!jarvis || withinBootGrace || handoff.createdAt <= startedAt) continue;
    pending.push({ handoff, scope: Object.freeze({ ...scope }) });
  }
  if (pending.length > 0 && !burstTimer) {
    burstTimer = setTimeout(() => flush(broadcast), BURST_MS);
    burstTimer.unref?.();
  }
}

export function initJarvisNarrator(
  broadcast: ScopedNarrationBroadcast,
  source: NarratorHandoffSource = defaultSource(),
): void {
  if (unsubscribe) return;
  startedAt = Date.now();
  unsubscribe = source.onChange((scope) => onChange(scope, broadcast, source));
}

export function shutdownJarvisNarrator(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = null;
  pending = [];
  seen.clear();
  startedAt = 0;
}
