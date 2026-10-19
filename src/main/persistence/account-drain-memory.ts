/**
 * Memória de drenagem — o que faz o carrossel ANDAR em vez de quicar.
 *
 * No modo fila (AGY pessoal) só a identidade viva é medível: a leitura mora
 * numa linha nativa que descreve quem está logado agora. Quando o trabalho
 * passa da conta A para a B, a linha passa a descrever B e A volta a parecer
 * "sem medição" — então a regra a escolhia de novo na rodada seguinte, e o
 * roteador ficava indo e voltando entre duas contas em vez de avançar.
 *
 * Aqui guardamos o que já foi provado: A estava no limiar, e a janela dela
 * reabre em X. Até lá ela não é destino preferencial. Não é bloqueio — se
 * nenhuma irmã tiver folga, a regra volta a escolhê-la e a fatia que resta é
 * consumida (segunda volta). Memória só de processo: reiniciar o app a
 * esquece, e a próxima leitura a reconstrói.
 */

/**
 * Até quando lembrar que a conta drenou. O reset CONHECIDO e futuro manda,
 * mesmo quando é mais curto que o fallback: um bucket de 5 Horas que cruza o
 * limiar 5 min antes de reabrir não pode ficar fora da preferência por mais
 * 55 min — no modo fila, conta que não é escolhida não ganha leitura nova que
 * limpe a lembrança, e a exclusão se auto-sustenta. Sem reset, ou com reset já
 * vencido (que gravaria lembrança expirando no mesmo instante, fazendo o
 * carrossel quicar), vale o fallback.
 */
export function drainMemoryUntil(
  resetsAt: number | undefined | null,
  now: number,
  fallbackMs: number,
): number {
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > now) {
    return resetsAt;
  }
  return now + fallbackMs;
}

/** accountId → instante em que a janela cheia reabre. */
const drainedUntil = new Map<string, number>();

/** Anota a conta como drenada até `reopenAt`. Reabertura no passado é no-op. */
export function noteAccountDrained(accountId: string, reopenAt: number): void {
  if (!Number.isFinite(reopenAt)) return;
  const current = drainedUntil.get(accountId) ?? 0;
  if (reopenAt > current) drainedUntil.set(accountId, reopenAt);
}

export function isRememberedDrained(accountId: string, now: number): boolean {
  const until = drainedUntil.get(accountId);
  if (until === undefined) return false;
  if (until <= now) {
    drainedUntil.delete(accountId);
    return false;
  }
  return true;
}

/** As que ainda valem; a leitura aproveita e limpa as vencidas. */
export function drainedAccountIds(now: number): Set<string> {
  const out = new Set<string>();
  for (const [accountId, until] of [...drainedUntil]) {
    if (until <= now) drainedUntil.delete(accountId);
    else out.add(accountId);
  }
  return out;
}

/**
 * Prova fresca em contrário: a conta foi medida abaixo do limiar, então a
 * lembrança morre. Sem isto uma atribuição errada manteria uma conta saudável
 * fora da preferência até a janela que a marcou reabrir — que pode ser a
 * Semanal, ou seja, dias.
 */
export function forgetAccountDrain(accountId: string): void {
  drainedUntil.delete(accountId);
}

export function forgetDrainMemory(): void {
  drainedUntil.clear();
}
