/**
 * Destilação de memória no fim de sessão de pane (fatia 2 da memória Jev).
 * Quando um pane de CLI termina, os resumos dos handoffs de sucesso daquela
 * sessão viram UMA linha `session-digest` — se o Jev aprovar a retenção. A
 * procedência deixa explícito que relato de agente não é prova factual.
 *
 * Ordens de custo: sessão trivial (sem handoff com resumo), duplicata contra
 * o top-3 do FTS5 e o mesmo digest já aguardando o Jev pulam com ZERO
 * chamadas ao Jev. Sem teto diário (decisão do operador, 2026-09-27): o que
 * segura tempestade de saídas simultâneas é o dedupe por conteúdo, não uma
 * cota. Jev indisponível deixa o resumo na fila durável para uma nova chance.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import { getProjectDomainStores } from '../orch/project-domain-store-registry';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { tapSessionExit } from '../pty/pty-manager';
import { distillHandoffSummary } from '../jev/jev-memory-distill';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { distillMemoryWithRetry, recordMemoryRetentionSkip } from './trusted-memory';
import { getWorkspaceMemoryStore } from './workspace-memory';

/** Resumos por sessão que entram no digest. */
const DIGEST_MAX_HANDOFFS = 3;

const SESSION_DIGEST_SOURCE = 'trusted:session-digest';

/** Etapa em que o banco faltou: handoffs da sessão, banco de memória, dedupe/recall ou a retenção. */
export type StoreUnavailableStage = 'handoffs' | 'memory-store' | 'recall' | 'retain' | 'distiller';

/** Causa categórica de um banco indisponível — nunca o texto do erro. */
export type StoreFailureCause = 'scope-collision' | 'not-configured' | 'closed' | 'busy' | 'other';

export interface SessionDigestOutcome {
  readonly retained: boolean;
  readonly reason:
    | 'no-scope'
    | 'flag-off'
    | 'store-unavailable'
    | 'trivial'
    | 'dedupe'
    | 'jev-skip'
    | 'ok';
  /**
   * Só em `store-unavailable`: `<etapa>.<causa>`. O diário mostrava 119
   * `store-unavailable` sem dizer qual banco nem por quê; a categoria basta
   * para separar colisão de escopo (F-1006), banco fechado e lock do SQLite.
   */
  readonly detail?: `${StoreUnavailableStage}.${StoreFailureCause}`;
  /** Id da linha anterior substituída, quando houve supersede. */
  readonly supersededId?: string;
}

/**
 * Lê só a FORMA do erro para escolher uma categoria. O texto em si (caminhos,
 * ids, SQL) nunca sai daqui: o diário do Jev e o contador do workspace guardam
 * apenas o rótulo.
 */
export function storeFailureCause(error: unknown): StoreFailureCause {
  const message = error instanceof Error ? error.message : String(error);
  if (/scope identity collision/i.test(message)) return 'scope-collision';
  if (/requires configure/i.test(message)) return 'not-configured';
  if (/\bis closed\b|not open/i.test(message)) return 'closed';
  if (/SQLITE_BUSY|database is locked/i.test(message)) return 'busy';
  return 'other';
}

interface SessionHandoffRow {
  readonly id: string;
  readonly sessionId?: string;
  readonly status: string;
  readonly summary?: string | null;
  readonly evidenceTrust?: string;
}

interface SessionHandoffSource {
  list(filter: { sessionIds: string[]; includeDelivered: true }): SessionHandoffRow[];
}

export interface SessionExitMemoryDeps {
  readonly getStores?: (
    scope: ProjectExecutionScope,
  ) => { handoffs: SessionHandoffSource };
  readonly distill?: typeof distillHandoffSummary;
  readonly now?: () => number;
}

/** Digests aguardando o Jev, por banco de workspace (dedupe em voo). */
const pendingDigests = new WeakMap<object, Set<string>>();

/** Query FTS: as primeiras palavras do digest bastam para achar duplicatas. */
function digestQuery(digest: string): string {
  return digest.split(/\s+/).slice(0, 12).join(' ');
}

/**
 * F-1006: `agent.scope` é a EXECUÇÃO (worktree da aba/writer); os stores do
 * projeto (handoffs e memória) vivem no escopo de COORDENAÇÃO. Abrir os
 * stores pela execução com o mesmo projectId/checkoutId e outra raiz bate
 * na guarda de identidade do registry ("project store scope identity
 * collision") e a destilação pulava como `store-unavailable`. A coordenação
 * só vale com a mesma identidade de projeto/checkout/instalação — prova em
 * contrário, fail-closed no escopo de execução (nunca outro projeto).
 */
function memoryScopeFor(
  agent: OwnedAgentSessionInfo | null | undefined,
): ProjectExecutionScope | undefined {
  if (!agent) return undefined;
  const coordination = agent.coordinationScope;
  if (
    coordination &&
    coordination.projectId === agent.scope.projectId &&
    coordination.checkoutId === agent.scope.checkoutId &&
    coordination.installationId === agent.scope.installationId
  ) {
    return coordination;
  }
  return agent.scope;
}

export async function distillSessionExitMemory(
  input: {
    readonly sessionId: string;
    readonly agent: OwnedAgentSessionInfo | null;
  },
  deps: SessionExitMemoryDeps = {},
): Promise<SessionDigestOutcome> {
  const scope = memoryScopeFor(input.agent);
  const skip = (
    reason: Exclude<SessionDigestOutcome['reason'], 'ok' | 'store-unavailable'>,
  ): SessionDigestOutcome => {
    recordMemoryRetentionSkip(scope, reason);
    return { retained: false, reason };
  };
  const storeUnavailable = (stage: StoreUnavailableStage, error: unknown): SessionDigestOutcome => {
    const detail = `${stage}.${storeFailureCause(error)}` as const;
    recordMemoryRetentionSkip(scope, `store-unavailable:${detail}`);
    return { retained: false, reason: 'store-unavailable', detail };
  };
  if (!scope) return skip('no-scope');
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    return skip('flag-off');
  }

  let handoffs: SessionHandoffRow[];
  try {
    const getStores =
      deps.getStores ??
      ((target: ProjectExecutionScope) =>
        getProjectDomainStores(target));
    // Entregue ou não: o helper que concluiu já teve o handoff marcado como
    // submetido antes do auto-close.
    handoffs = getStores(scope).handoffs.list({
      sessionIds: [input.sessionId],
      includeDelivered: true,
    });
  } catch (error) {
    return storeUnavailable('handoffs', error);
  }

  const delivered = handoffs.filter(
    (handoff) =>
      handoff.sessionId === input.sessionId &&
      handoff.status === 'success' &&
      typeof handoff.summary === 'string' &&
      handoff.summary.trim(),
  );
  if (delivered.length === 0) return skip('trivial');
  const summaries = delivered
    // list() vem em created_at ASC: os mais recentes são o fim da sessão.
    .slice(-DIGEST_MAX_HANDOFFS)
    .map((handoff) => handoff.summary!.trim());
  // O limite de 400 chars é do resultado destilado. Cortar a entrada aqui
  // apagava correções e fatos do fim da sessão antes da avaliação do Jev.
  const digest = summaries.join(' | ').replace(/\s+/g, ' ').trim();
  if (!digest) return skip('trivial');

  let store: ReturnType<typeof getWorkspaceMemoryStore>;
  try {
    store = getWorkspaceMemoryStore(scope);
  } catch (error) {
    return storeUnavailable('memory-store', error);
  }
  // Saídas simultâneas com o mesmo conteúdo: só a primeira vai ao Jev (o FTS
  // ainda não vê a linha que ela vai gravar).
  const pending = pendingDigests.get(store) ?? new Set<string>();
  if (pending.has(digest)) return skip('dedupe');
  pending.add(digest);
  pendingDigests.set(store, pending);
  let stage: StoreUnavailableStage = 'recall';
  try {
    // Dedupe contra o top-3 do FTS5 do próprio workspace.
    const hits = store.recall({
      query: digestQuery(digest),
      limit: 3,
      includeGlobal: false,
      trustedOnly: true,
    });
    if (hits.some((hit) => hit.content.includes(digest))) {
      return skip('dedupe');
    }

    // O digest anterior da missão é achado pela identidade, não por palavras.
    const missionId = input.agent?.missionId;
    const stale = missionId
      ? store.latestActiveWithLine(SESSION_DIGEST_SOURCE, `Mission: ${missionId}`)
      : null;
    stage = 'retain';
    const result = await distillMemoryWithRetry(
      scope,
      {
        type: 'session-digest',
        title: 'Session digest',
        // Só o resultado aprovado substitui este marcador. Não duplicar o
        // digest bruto na fila nem aplicar o teto de um handoff ao conjunto.
        summary: 'Pending distillation',
        ...(missionId ? { missionId } : {}),
        reference: input.sessionId,
      },
      digest,
      {},
      stale ? { supersedes: stale } : {},
      deps.distill ?? distillHandoffSummary,
    );
    // O helper registra a razão precisa (incluindo timeout/sem rota) e fila.
    if (!result) return { retained: false, reason: 'jev-skip' };
    return {
      retained: true,
      reason: 'ok',
      ...(stale ? { supersededId: stale } : {}),
    };
  } catch (error) {
    return storeUnavailable(stage, error);
  } finally {
    pending.delete(digest);
    if (pending.size === 0) pendingDigests.delete(store);
  }
}

let ensureDisposer: (() => void) | null = null;

/**
 * Instala o tap de fim de sessão (uma vez por processo). Fire-and-forget:
 * a destilação nunca segura o encerramento do pane.
 */
export function ensureSessionExitMemoryDistiller(): void {
  if (ensureDisposer) return;
  ensureDisposer = tapSessionExit((sessionId, agent) => {
    void distillSessionExitMemory({ sessionId, agent }).catch((error: unknown) => {
      recordMemoryRetentionSkip(
        memoryScopeFor(agent),
        `store-unavailable:distiller.${storeFailureCause(error)}`,
      );
    });
  });
}

/** Test-only. */
export function resetSessionExitMemoryDistillerForTests(): void {
  ensureDisposer?.();
  ensureDisposer = null;
}
