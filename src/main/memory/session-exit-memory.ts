/**
 * Destilação de memória no fim de sessão de pane (fatia 2 da memória Jev).
 * Quando um pane de CLI termina, os resumos dos handoffs de sucesso daquela
 * sessão com evidência verificada pelo Main (`evidenceTrust: nexus-trusted`)
 * viram UMA linha trusted `session-digest` — se o Jev aprovar. Declaração do
 * agente sem evidência nunca vira memória trusted.
 *
 * Ordens de custo: sessão trivial (sem handoff com resumo), duplicata contra
 * o top-3 do FTS5 e o mesmo digest já aguardando o Jev pulam com ZERO
 * chamadas ao Jev. Sem teto diário (decisão do operador, 2026-09-27): o que
 * segura tempestade de saídas simultâneas é o dedupe por conteúdo, não uma
 * cota. Fail-open: qualquer falha apenas não grava.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import { getProjectDomainStores } from '../orch/project-domain-store-registry';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { tapSessionExit } from '../pty/pty-manager';
import {
  normalizeDistilledSummary,
  distillHandoffSummary,
} from '../jev/jev-memory-distill';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { retainTrustedMemoryBestEffort } from './trusted-memory';
import { getWorkspaceMemoryStore } from './workspace-memory';

/** Resumos por sessão que entram no digest. */
const DIGEST_MAX_HANDOFFS = 3;

const SESSION_DIGEST_SOURCE = 'trusted:session-digest';

export interface SessionDigestOutcome {
  readonly retained: boolean;
  readonly reason:
    | 'no-scope'
    | 'flag-off'
    | 'store-unavailable'
    | 'trivial'
    | 'unverified'
    | 'dedupe'
    | 'jev-skip'
    | 'ok';
  /** Id da linha anterior substituída, quando houve supersede. */
  readonly supersededId?: string;
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

export async function distillSessionExitMemory(
  input: {
    readonly sessionId: string;
    readonly agent: OwnedAgentSessionInfo | null;
  },
  deps: SessionExitMemoryDeps = {},
): Promise<SessionDigestOutcome> {
  const scope = input.agent?.scope;
  if (!scope) return { retained: false, reason: 'no-scope' };
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.workspaceMemory)
  ) {
    return { retained: false, reason: 'flag-off' };
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
  } catch {
    return { retained: false, reason: 'store-unavailable' };
  }

  const delivered = handoffs.filter(
    (handoff) =>
      handoff.sessionId === input.sessionId &&
      handoff.status === 'success' &&
      typeof handoff.summary === 'string' &&
      handoff.summary.trim(),
  );
  if (delivered.length === 0) return { retained: false, reason: 'trivial' };
  const summaries = delivered
    .filter((handoff) => handoff.evidenceTrust === 'nexus-trusted')
    // list() vem em created_at ASC: os mais recentes são o fim da sessão.
    .slice(-DIGEST_MAX_HANDOFFS)
    .map((handoff) => handoff.summary!.trim());
  if (summaries.length === 0) return { retained: false, reason: 'unverified' };

  const digest = normalizeDistilledSummary(summaries.join(' | '));
  if (!digest) return { retained: false, reason: 'trivial' };

  const store = getWorkspaceMemoryStore(scope);
  // Saídas simultâneas com o mesmo conteúdo: só a primeira vai ao Jev (o FTS
  // ainda não vê a linha que ela vai gravar).
  const pending = pendingDigests.get(store) ?? new Set<string>();
  if (pending.has(digest)) return { retained: false, reason: 'dedupe' };
  pending.add(digest);
  pendingDigests.set(store, pending);
  try {
    // Dedupe contra o top-3 do FTS5 do próprio workspace.
    const hits = store.recall({
      query: digestQuery(digest),
      limit: 3,
      includeGlobal: false,
      trustedOnly: true,
    });
    if (hits.some((hit) => hit.content.includes(digest))) {
      return { retained: false, reason: 'dedupe' };
    }

    const distill = deps.distill ?? distillHandoffSummary;
    const approved = await distill({ summary: digest });
    if (!approved) return { retained: false, reason: 'jev-skip' };

    // O digest anterior da missão é achado pela identidade, não por palavras.
    const missionId = input.agent?.missionId;
    const stale = missionId
      ? store.latestActiveWithLine(SESSION_DIGEST_SOURCE, `Mission: ${missionId}`)
      : null;
    const result = retainTrustedMemoryBestEffort(
      scope,
      {
        type: 'session-digest',
        title: 'Session digest',
        summary: digest,
        ...(missionId ? { missionId } : {}),
        reference: input.sessionId,
      },
      stale ? { supersedes: stale } : {},
    );
    if (!result) return { retained: false, reason: 'store-unavailable' };
    return {
      retained: true,
      reason: 'ok',
      ...(stale ? { supersededId: stale } : {}),
    };
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
    void distillSessionExitMemory({ sessionId, agent }).catch(() => {
      // best-effort: sem memória é melhor que pane preso no exit.
    });
  });
}

/** Test-only. */
export function resetSessionExitMemoryDistillerForTests(): void {
  ensureDisposer?.();
  ensureDisposer = null;
}
