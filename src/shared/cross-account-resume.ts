/**
 * F-1473: a troca de conta por limite continua a MESMA conversa quando a CLI
 * guarda o histórico fora da conta — a conta troca só a credencial.
 *
 * Claude: o transcript mora por checkout, não por conta —
 * `<userData>/provider-state/claude/<checkoutId>/claude/{projects,…}`, ligado
 * no HOME privado de todo pane Claude (`prepareEphemeralHome`, hooks-gen.ts)
 * qualquer que seja a conta. A conta entra só como credencial
 * (`CLAUDE_SECURESTORAGE_CONFIG_DIR` da conta gerenciada, OAuth por env ou
 * API key), então `--resume <id>` na conta B lê o mesmo JSONL que a A gravou.
 * Só upstream Anthropic dos dois lados: conta Claude roteada para terceiro
 * (GLM e afins por `ANTHROPIC_BASE_URL`) não recebe a conversa da Anthropic.
 *
 * Fora (continuam com sessão nova + pacote de continuidade):
 * - Codex: o rollout também é por checkout, mas não está provado que outra
 *   conta ChatGPT aceita o histórico — ele leva itens de raciocínio cifrados
 *   (`encrypted_content`) emitidos para a conta que os gerou.
 * - AGY, Devin, Kimi, Grok…: o home inteiro (com o histórico) é por conta.
 */

/**
 * Ligado por padrão: as contas do mesmo adapter são do mesmo operador. Não há
 * tela de failover onde caiba a opção; desligar é trocar esta constante.
 */
export const CROSS_ACCOUNT_NATIVE_RESUME = true;

/** Adapter → único upstream em que a conversa atravessa contas. */
const SHARED_HISTORY_UPSTREAM: ReadonlyMap<string, string> = new Map([
  ['claude', 'anthropic'],
]);

export interface ResumeAccountRoute {
  readonly adapterId: string;
  /** `Account.upstream`; ausente = o default do adapter. */
  readonly upstream?: string;
}

/**
 * O resume nativo de `adapterId` enxerga a conversa feita em outra conta deste
 * adapter? Com as contas, exige as duas no MESMO adapter e no upstream
 * compartilhado; conta ausente (login nativo) vale como o default.
 */
export function nativeResumeAcrossAccounts(
  adapterId: string,
  accounts: {
    readonly from?: ResumeAccountRoute | null;
    readonly to?: ResumeAccountRoute | null;
  } = {},
  enabled = CROSS_ACCOUNT_NATIVE_RESUME,
): boolean {
  const upstream = SHARED_HISTORY_UPSTREAM.get(adapterId);
  if (!enabled || !upstream) return false;
  return [accounts.from, accounts.to].every(
    (account) =>
      !account ||
      (account.adapterId === adapterId && (account.upstream ?? upstream) === upstream),
  );
}
