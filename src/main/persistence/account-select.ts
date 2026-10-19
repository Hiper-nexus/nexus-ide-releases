import type { Account } from '../../shared/account-types';
import {
  compareAccountHeadroom,
  DRAIN_THRESHOLD,
  headroomReadings,
  isHeadroomDraining,
  isHeadroomExhausted,
  unreadWindowWithProvenHeadroom,
  type DrainEvidence,
  type HeadroomInput,
} from '../quota/account-headroom';

/**
 * Pure failover selection: from the accounts of one adapter, choose the next
 * usable one — skip the excluded account and anything still on cooldown.
 *
 * The active account stays until its measured availability is zero (the
 * worst window is full) or it is no longer a candidate. A sibling with more
 * remaining quota does not take a new pane early. Unknown quota keeps the
 * active account. With no active account, the freest measured candidate wins.
 *
 * F-995: with the per-window readings (`quotaByAccountId`) the comparison only
 * uses comparable windows (`compareAccountHeadroom`), and an active account
 * that was read partially (e.g. Semanal measured, 5 Horas unread) does not
 * keep the pane against a sibling that PROVED headroom in the window the
 * active one never read — unread is not headroom. An active account with no
 * reading at all still stays (quota service down is not evidence).
 * No I/O — unit tested in isolation.
 */
export function chooseAccount(
  accounts: Account[],
  activeId: string | null,
  excludeId: string | null,
  now: number,
  quotaScoreByAccountId?: ReadonlyMap<string, number>,
  quotaByAccountId?: ReadonlyMap<string, HeadroomInput>,
  drain?: DrainEvidence,
): Account | null {
  const candidates = accounts.filter(
    (a) => a.id !== excludeId && (!a.cooldownUntil || a.cooldownUntil <= now),
  );
  if (candidates.length === 0) return null;
  const active = candidates.find((a) => a.id === activeId) ?? null;
  if (quotaByAccountId) {
    return chooseByWindows(candidates, active, quotaByAccountId, drain);
  }
  const measured = candidates
    .map((account) => ({
      account,
      score: quotaScoreByAccountId?.get(account.id),
    }))
    .filter(
      (entry): entry is { account: Account; score: number } =>
        typeof entry.score === 'number' && Number.isFinite(entry.score),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.account.createdAt - right.account.createdAt,
    );

  if (active) {
    const activeScore = quotaScoreByAccountId?.get(active.id);
    // 0 = janela cheia (quotaAvailabilityScore de usedRatio 1). Folga menor
    // que a irmã não é término: o hit real tira a conta da lista por cooldown.
    if (
      typeof activeScore === 'number' &&
      Number.isFinite(activeScore) &&
      activeScore <= 0
    ) {
      const replacement = measured.find(
        (entry) => entry.account.id !== active.id && entry.score > 0,
      );
      if (replacement) return replacement.account;
    }
    return active;
  }
  return (
    measured[0]?.account ??
    [...candidates].sort((a, b) => a.createdAt - b.createdAt)[0]
  );
}

function chooseByWindows(
  candidates: readonly Account[],
  active: Account | null,
  quotaByAccountId: ReadonlyMap<string, HeadroomInput>,
  drain?: DrainEvidence,
): Account {
  const quota = (account: Account) => quotaByAccountId.get(account.id);
  const ranked = [...candidates].sort(
    (left, right) =>
      compareAccountHeadroom(quota(right), quota(left)) ||
      left.createdAt - right.createdAt,
  );
  if (!active) return ranked[0];
  const best = ranked.find(
    (account) => account.id !== active.id && !isHeadroomExhausted(quota(account)),
  );
  if (!best) return active;
  const activeQuota = quota(active);
  if (isHeadroomExhausted(activeQuota)) return best;
  // Drenagem: a ativa cruzou o limiar e ainda tem fatia, mas o trabalho NOVO
  // vai para quem não cruzou. Só vale com evidência (leitura provider-api
  // fresca da ATIVA); o destino não precisa de leitura, senão nunca
  // rotacionaríamos onde as irmãs são inmensuráveis (AGY pessoal).
  // Preferência, não banimento: com todas drenando a regra abaixo decide e o
  // resto da janela é consumido numa segunda volta.
  if (drain && isHeadroomDraining(activeQuota, DRAIN_THRESHOLD, drain)) {
    const fresh = ranked.find(
      (account) =>
        account.id !== active.id &&
        !isHeadroomExhausted(quota(account)) &&
        !isHeadroomDraining(quota(account), DRAIN_THRESHOLD, drain),
    );
    if (fresh) return fresh;
  }
  // Ativa sem leitura nenhuma: nada a comparar — fica (cota fora do ar).
  if (headroomReadings(activeQuota).size === 0) return active;
  if (
    unreadWindowWithProvenHeadroom(activeQuota, quota(best)) &&
    compareAccountHeadroom(quota(best), activeQuota) > 0
  ) {
    return best;
  }
  return active;
}
