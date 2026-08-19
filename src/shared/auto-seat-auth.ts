/**
 * Auto-pilot CLI seating: only logged-in / keyed CLIs get seats.
 *
 * Via Rápida / Maestro seed / role-template expansion must NEVER reserve,
 * toast, or spawn an unauthenticated CLI (LongCat without key, Kimi without
 * login, …). A civilian who explicitly picked that CLI may still see the
 * login/key toast.
 */

import {
  autoSeatReadiness,
  isLiveSeat,
  type AuthReadiness,
} from './auth-readiness';

export type { AuthReadiness };
export { isLiveSeat, autoSeatReadiness };

export const PREFERRED_AUTO_SEAT_CLIS = [
  'claude',
  'codex',
  'agy',
  'grok',
  'glm',
  'kimi',
] as const;

export type AutoSeatAuthStrategy =
  | 'credentialless'
  | 'subscription'
  | 'api-key'
  | 'login-needed'
  | string;

export interface AutoSeatProviderView {
  readonly adapterId: string;
  readonly authStrategy?: AutoSeatAuthStrategy;
  readonly hasKey?: boolean;
  readonly enabled?: boolean;
  /** 5-state file/CLI proof. Only `present` seats. */
  readonly readiness?: AuthReadiness;
}

export function isAuthStrategyReady(
  strategy: AutoSeatAuthStrategy | undefined | null,
): boolean {
  return (
    strategy === 'subscription' ||
    strategy === 'api-key' ||
    strategy === 'credentialless'
  );
}

/**
 * Live provider snapshot is the authority. Missing snapshot = fail-closed
 * for auto-pilot (do not invent a seat).
 */
export function isProviderAuthedForAutoSeat(
  provider: AutoSeatProviderView | null | undefined,
): boolean {
  if (!provider) return false;
  return isLiveSeat(autoSeatReadiness(provider));
}

export function providerViewForAdapter(
  adapterId: string,
  providers: readonly AutoSeatProviderView[],
): AutoSeatProviderView | undefined {
  return providers.find((item) => item.adapterId === adapterId);
}

export function filterAuthedAdapters<T extends { readonly id: string }>(
  adapters: readonly T[],
  providers: readonly AutoSeatProviderView[],
): T[] {
  return adapters.filter((adapter) =>
    isProviderAuthedForAutoSeat(providerViewForAdapter(adapter.id, providers)),
  );
}

export function rankAutoSeatCli(id: string): number {
  const index = (PREFERRED_AUTO_SEAT_CLIS as readonly string[]).indexOf(id);
  return index === -1 ? PREFERRED_AUTO_SEAT_CLIS.length : index;
}

export function sortAutoSeatPreference<T extends { readonly id: string }>(
  adapters: readonly T[],
): T[] {
  return [...adapters].sort((left, right) => {
    const byRank = rankAutoSeatCli(left.id) - rankAutoSeatCli(right.id);
    return byRank === 0 ? left.id.localeCompare(right.id) : byRank;
  });
}

export type FirstWaveWriterSeat = {
  readonly id: string;
  readonly cli: string;
  readonly model?: string;
};

/**
 * First-wave / auto-dispatch seating. Unauthed Kimi/LongCat/OpenCode never
 * keep a seat. Remint the role onto Claude/Codex/AGY/Grok/GLM when those
 * are live-authed; silent skip when no successor exists.
 */
export function remintWriterCliForAutoSeat<T extends FirstWaveWriterSeat>(
  writer: T,
  providers: readonly AutoSeatProviderView[],
): T | null {
  if (isProviderAuthedForAutoSeat(providerViewForAdapter(writer.cli, providers))) {
    return writer;
  }
  for (const preferred of PREFERRED_AUTO_SEAT_CLIS) {
    if (preferred === writer.cli) continue;
    if (
      isProviderAuthedForAutoSeat(providerViewForAdapter(preferred, providers))
    ) {
      return { ...writer, cli: preferred, model: '' };
    }
  }
  return null;
}

export function selectFirstWaveWriters<T extends FirstWaveWriterSeat>(
  writers: readonly T[],
  providers: readonly AutoSeatProviderView[],
): T[] {
  const selected: T[] = [];
  for (const writer of writers) {
    const reminted = remintWriterCliForAutoSeat(writer, providers);
    if (reminted) selected.push(reminted);
  }
  return selected;
}

export type UnauthedSpawnDecision =
  | 'spawn'
  | 'skip-silent'
  | 'allow-login-toast';

/**
 * Auto-pilot never toasts "cole sua API key". Civilian explicit pick may.
 */
export function decideUnauthedAutoPilotSpawn(input: {
  readonly authStrategy?: AutoSeatAuthStrategy | null;
  readonly civilianPicked: boolean;
}): UnauthedSpawnDecision {
  if (isAuthStrategyReady(input.authStrategy)) return 'spawn';
  if (input.civilianPicked) return 'allow-login-toast';
  return 'skip-silent';
}

export function isLoginKeyToastMessage(message: string): boolean {
  return /sem login\/key|cole sua API key|cole a API key|login-needed|missing-credential|key-missing|unauthenticated-cli-skipped/i.test(
    message,
  );
}

export function spawnErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

export function shouldToastSpawnFailure(input: {
  readonly civilianPicked: boolean;
  readonly error: unknown;
}): boolean {
  if (input.civilianPicked) return true;
  return !isLoginKeyToastMessage(spawnErrorMessage(input.error));
}
