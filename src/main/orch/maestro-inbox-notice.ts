// F-1359: a colagem das entregas espera a borda busy→idle do Maestro (por
// design: nunca escrever no meio da resposta). Um Maestro que trabalha sem
// parar não via a fila — na s240, 10 entregas ficaram 30+ min `queued` e ele
// só soube por acaso. O aviso vai pelo canal de contexto dos hooks
// (additionalContext do PostToolUse): uma linha curta, só quando entra
// entrega que ele ainda não viu, nunca a cada ferramenta.
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { GateRole } from './gate';
import { getProjectDomainStores } from './project-domain-store-registry';
import { handoffDeliveryEligible } from './idle-delivery';

export interface InboxNoticeContext {
  readonly role?: GateRole;
  readonly missionId?: string;
  readonly sessionId?: string;
  readonly scope?: Readonly<ProjectExecutionScope>;
}

export type ListUndeliveredHandoffs = (
  scope: Readonly<ProjectExecutionScope>,
  missionId: string,
) => readonly Handoff[];

const MAX_LISTED = 5;
const MAX_NOTICE_CHARS = 400;
const MAX_TRACKED_SESSIONS = 256;

/** sessionId do Maestro → ids da fila no último aviso. */
const announced = new Map<string, ReadonlySet<string>>();

const defaultListUndelivered: ListUndeliveredHandoffs = (scope, missionId) =>
  getProjectDomainStores(scope as ProjectExecutionScope).handoffs.list({
    missionId,
    includeDelivered: false,
  });

function label(text: string | undefined, max: number): string {
  // eslint-disable-next-line no-control-regex -- remove controles de propósito
  const clean = (text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function formatInboxNotice(pending: readonly Handoff[]): string {
  const listed = pending
    .slice(0, MAX_LISTED)
    .map((h) => `${label(h.fromAgent, 32) || 'helper'} ${label(h.id, 64).slice(0, 16)} ${h.status}`);
  const more = pending.length > MAX_LISTED ? `; +${pending.length - MAX_LISTED}` : '';
  const text =
    `[Nexus] ${pending.length} ${pending.length === 1 ? 'entrega' : 'entregas'} na fila: ` +
    `${listed.join('; ')}${more}. Elas colam quando seu turno acabar; ` +
    'para ler agora, nexus_handoff_list.';
  return text.length > MAX_NOTICE_CHARS ? `${text.slice(0, MAX_NOTICE_CHARS - 1)}…` : text;
}

/**
 * Linha de aviso para o Maestro desta sessão, ou null. Só avisa quando a fila
 * tem entrega que o último aviso não listou; fila vazia zera a memória.
 */
export function maestroInboxNotice(
  ctx: InboxNoticeContext,
  listUndelivered: ListUndeliveredHandoffs = defaultListUndelivered,
): string | null {
  if (ctx.role !== 'orchestrator' || !ctx.missionId || !ctx.sessionId || !ctx.scope) {
    return null;
  }
  let pending: Handoff[];
  try {
    pending = listUndelivered(ctx.scope, ctx.missionId).filter(
      (h) => handoffDeliveryEligible(h) && h.sessionId !== ctx.sessionId,
    );
  } catch {
    return null;
  }
  const seen = announced.get(ctx.sessionId);
  announced.delete(ctx.sessionId);
  if (pending.length === 0) return null;
  announced.set(ctx.sessionId, new Set(pending.map((h) => h.id)));
  if (announced.size > MAX_TRACKED_SESSIONS) {
    const oldest = announced.keys().next().value;
    if (oldest !== undefined) announced.delete(oldest);
  }
  return pending.some((h) => !seen?.has(h.id)) ? formatInboxNotice(pending) : null;
}

export function __resetMaestroInboxNoticeForTests(): void {
  announced.clear();
}
