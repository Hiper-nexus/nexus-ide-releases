/**
 * Destilação de memória no fim de sessão de pane (fatia 2 da memória Jev).
 * Quando um pane de CLI termina, os resumos dos handoffs de sucesso daquela
 * sessão viram UMA linha trusted `session-digest` — se o Jev aprovar.
 *
 * Ordens de custo: sessão trivial (sem handoff com resumo), teto diário
 * atingido e duplicata contra o top-3 do FTS5 pulam com ZERO chamadas ao
 * Jev. Fail-open: qualquer falha apenas não grava.
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

/** Teto de digests gravados por dia, por projeto (banco do workspace). */
export const DAILY_SESSION_DIGEST_CAP = 10;

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
    | 'daily-cap'
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
}

export interface SessionExitMemoryDeps {
  readonly getStores?: (
    scope: ProjectExecutionScope,
  ) => { handoffs: { list(): SessionHandoffRow[] } };
  readonly distill?: typeof distillHandoffSummary;
  readonly now?: () => number;
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

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
        getProjectDomainStores(target) as unknown as {
          handoffs: { list(): SessionHandoffRow[] };
        });
    handoffs = getStores(scope).handoffs.list();
  } catch {
    return { retained: false, reason: 'store-unavailable' };
  }

  const summaries = handoffs
    .filter(
      (handoff) =>
        handoff.sessionId === input.sessionId &&
        handoff.status === 'success' &&
        typeof handoff.summary === 'string' &&
        handoff.summary.trim(),
    )
    .slice(0, DIGEST_MAX_HANDOFFS)
    .map((handoff) => handoff.summary!.trim());
  if (summaries.length === 0) return { retained: false, reason: 'trivial' };

  const digest = normalizeDistilledSummary(summaries.join(' | '));
  if (!digest) return { retained: false, reason: 'trivial' };

  const store = getWorkspaceMemoryStore(scope);
  const now = deps.now ?? Date.now;
  if (
    store.countActiveSince(
      SESSION_DIGEST_SOURCE,
      startOfDay(now()),
    ) >= DAILY_SESSION_DIGEST_CAP
  ) {
    return { retained: false, reason: 'daily-cap' };
  }

  // Dedupe/supersede contra o top-3 do FTS5 do próprio workspace.
  const hits = store.recall({
    query: digestQuery(digest),
    limit: 3,
    includeGlobal: false,
    trustedOnly: true,
  });
  if (hits.some((hit) => hit.content.includes(digest))) {
    return { retained: false, reason: 'dedupe' };
  }
  const missionId = input.agent?.missionId;
  const stale = missionId
    ? hits.find(
        (hit) =>
          hit.source === SESSION_DIGEST_SOURCE &&
          hit.content.includes(`Mission: ${missionId}`),
      )
    : undefined;

  const distill = deps.distill ?? distillHandoffSummary;
  const approved = await distill({ summary: digest });
  if (!approved) return { retained: false, reason: 'jev-skip' };

  const result = retainTrustedMemoryBestEffort(
    scope,
    {
      type: 'session-digest',
      title: 'Session digest',
      summary: digest,
      ...(missionId ? { missionId } : {}),
      reference: input.sessionId,
    },
    stale ? { supersedes: stale.id } : {},
  );
  if (!result) return { retained: false, reason: 'store-unavailable' };
  return {
    retained: true,
    reason: 'ok',
    ...(stale ? { supersededId: stale.id } : {}),
  };
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
