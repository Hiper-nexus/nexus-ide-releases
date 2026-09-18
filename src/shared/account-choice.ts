/**
 * Recibo da escolha de conta no spawn: qual conta o pane usa, quem decidiu
 * (conta pinada pelo chamador, regra de folga, ativa, fallback, linhagem
 * nativa ou caminho legado), a folga medida da vencedora e as alternativas
 * com o motivo de cada perda. Rótulos SEMPRE mascarados — nunca id,
 * fingerprint ou token.
 */

export type AccountChoiceSource =
  | 'pinned'
  | 'headroom-rule'
  | 'active'
  | 'active-fallback'
  | 'native'
  | 'legacy';

export interface AccountHeadroom {
  /** Pior janela medida, em % (0-100). null = sem medição. */
  usedPct: number | null;
  /** Rótulo da janela medida ("Sessão", "Semanal"). */
  window: string | null;
  /** Epoch ms do reset da janela, quando conhecido. */
  resetsAt: number | null;
  /** quotaAvailabilityScore da entrada (0..1; 1 = livre). */
  score: number | null;
}

export interface AccountChoiceAlternative {
  label: string;
  usedPct: number | null;
  window: string | null;
  resetsAt: number | null;
  skipped:
    | 'cooldown'
    | 'no-credential'
    | 'less-headroom'
    | 'unknown-quota';
}

export interface AccountChoiceReceipt {
  adapterId: string;
  source: AccountChoiceSource;
  account: {
    label: string;
    mode: 'subscription' | 'api_key' | 'unknown';
  } | null;
  headroom: AccountHeadroom | null;
  alternatives: AccountChoiceAlternative[];
  decidedAt: number;
  /** Texto do aviso quando a decisão é um fallback com alerta. */
  note?: string;
}

/**
 * Mascara o rótulo da conta para o recibo: e-mail vira
 * `g•••@l•••.com.br` (1º char do local + 1º char do domínio + sufixo do TLD
 * a partir do primeiro ponto); não-e-mail vira `ab•••yz` quando > 6 chars,
 * senão `•••`. Nunca inclui id, fingerprint nem token.
 */
export function maskAccountLabel(label: string): string {
  const trimmed = label.trim();
  const at = trimmed.indexOf('@');
  if (at > 0 && at < trimmed.length - 1) {
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    const firstDot = domain.indexOf('.');
    const suffix = firstDot >= 0 ? domain.slice(firstDot) : '';
    return `${local[0]}•••@${domain[0]}•••${suffix}`;
  }
  if (trimmed.length > 6) {
    return `${trimmed.slice(0, 2)}•••${trimmed.slice(-2)}`;
  }
  return '•••';
}
