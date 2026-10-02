/**
 * Texto do chip "qual conta este pane usa" no cabeçalho do pane, derivado do
 * recibo da escolha de conta. Puro e sem React: o texto sai só do que o recibo
 * traz (nunca inventa folga, motivo ou horário) e todo rótulo passa de novo por
 * `maskAccountLabel` — idempotente sobre o já mascarado — para que um produtor
 * que esqueça a máscara não vaze e-mail na interface.
 */
import {
  maskAccountLabel,
  RECEIPT_NOTE_MAX_CHARS,
  RECEIPT_WINDOW_MAX_CHARS,
  sanitizeReceiptText,
  type AccountChoiceAlternative,
  type AccountChoiceReceipt,
  type AccountHeadroom,
} from './account-choice';

export interface AccountChoiceDisplayOptions {
  /** Relógio (epoch ms) para dizer "hoje" e "já reiniciou". Padrão: `Date.now()`. */
  readonly now?: number;
  /** Fuso IANA dos horários. Padrão: o do sistema. */
  readonly timeZone?: string;
}

/** Quantas alternativas o tooltip lista antes de resumir o resto em "+N". */
export const ACCOUNT_CHOICE_TOOLTIP_MAX_ALTERNATIVES = 3;

const NATIVE_CHIP_LABEL = 'conta nativa';
const API_KEY_CHIP_PREFIX = 'API key · ';

/** Origens em que as outras contas realmente concorreram (e por isso há "perdedoras"). */
const SOURCES_WITH_COMPETITION: ReadonlySet<AccountChoiceReceipt['source']> = new Set([
  'headroom-rule',
  'active',
  'active-fallback',
]);

/** Rótulo visível do chip, ou `null` quando o pane não deve mostrar chip. */
export function accountChoiceChipLabel(receipt: AccountChoiceReceipt): string | null {
  if (receipt.source === 'legacy') return null;
  const { account } = receipt;
  if (!account) return receipt.source === 'native' ? NATIVE_CHIP_LABEL : null;
  const masked = maskAccountLabel(account.label);
  return account.mode === 'api_key' ? `${API_KEY_CHIP_PREFIX}${masked}` : masked;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** "reinicia às 18:30" / "reinicia em 03/10 às 09:05" / "reiniciou às 08:00"; `null` se não der para formatar. */
function formatResetClause(
  resetsAt: number | null,
  now: number,
  timeZone: string | undefined,
): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  try {
    const time = new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(resetsAt);
    const dayKey = (ms: number): string =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(ms);
    const when =
      dayKey(resetsAt) === dayKey(now)
        ? `às ${time}`
        : `em ${new Intl.DateTimeFormat('pt-BR', {
            timeZone,
            day: '2-digit',
            month: '2-digit',
          }).format(resetsAt)} às ${time}`;
    return resetsAt > now ? `reinicia ${when}` : `reiniciou ${when}`;
  } catch {
    return null;
  }
}

function windowName(window: string | null): string | null {
  if (window === null) return null;
  return sanitizeReceiptText(window, RECEIPT_WINDOW_MAX_CHARS) || null;
}

/** "12% usado na janela Sessão (reinicia às 18:30)"; `null` sem percentual medido. */
function measuredPhrase(
  headroom: AccountHeadroom | null,
  now: number,
  timeZone: string | undefined,
): string | null {
  if (!headroom || headroom.usedPct === null) return null;
  const window = windowName(headroom.window);
  const reset = formatResetClause(headroom.resetsAt, now, timeZone);
  return (
    `${clampPercent(headroom.usedPct)}% usado` +
    (window ? ` na janela ${window}` : '') +
    (reset ? ` (${reset})` : '')
  );
}

function skippedReason(
  alternative: AccountChoiceAlternative,
  source: AccountChoiceReceipt['source'],
): string {
  switch (alternative.skipped) {
    case 'cooldown':
      return 'em espera';
    case 'no-credential':
      return 'sem credencial';
    case 'unknown-quota':
      return 'cota desconhecida';
    case 'less-headroom': {
      // Sob "ativa mantida" a irmã não perdeu por folga — a ativa fica até a
      // cota medida zerar —, então só se diz que ela estava disponível.
      const base = source === 'active' ? 'disponível' : 'menos folga';
      return alternative.usedPct === null
        ? base
        : `${base} (${clampPercent(alternative.usedPct)}% usado)`;
    }
  }
}

function alternativesSentence(receipt: AccountChoiceReceipt): string | null {
  if (!SOURCES_WITH_COMPETITION.has(receipt.source)) return null;
  const shown = receipt.alternatives.slice(0, ACCOUNT_CHOICE_TOOLTIP_MAX_ALTERNATIVES);
  if (shown.length === 0) return null;
  const items = shown.map(
    (alternative) =>
      `${maskAccountLabel(alternative.label)} — ${skippedReason(alternative, receipt.source)}`,
  );
  const rest = receipt.alternatives.length - shown.length;
  if (rest > 0) items.push(`+${rest} ${rest === 1 ? 'outra' : 'outras'}`);
  return `Alternativas: ${items.join('; ')}.`;
}

function noteSentence(note: string | undefined): string | null {
  if (!note) return null;
  const safe = sanitizeReceiptText(note, RECEIPT_NOTE_MAX_CHARS);
  if (!safe) return null;
  return `Aviso: ${/[.!?]$/.test(safe) ? safe : `${safe}.`}`;
}

/** A primeira(s) frase(s): quem decidiu e a folga medida (quando faz sentido dizê-la). */
function leadSentences(
  receipt: AccountChoiceReceipt,
  measured: string | null,
): string[] {
  switch (receipt.source) {
    case 'headroom-rule':
      return [
        `Conta escolhida pela regra de folga: ${measured ?? 'cota ainda não medida'}.`,
      ];
    case 'active':
      return [
        'Conta ativa mantida (a ativa fica até a cota medida zerar).',
        measured ? `Medido: ${measured}.` : 'Cota ainda não medida.',
      ];
    case 'active-fallback':
      return [
        'Conta ativa usada como último recurso.',
        measured ? `Medido: ${measured}.` : 'Cota ainda não medida.',
      ];
    case 'pinned':
      return [
        'Conta fixada por quem abriu o pane.',
        ...(measured ? [`Medido: ${measured}.`] : []),
      ];
    case 'native':
      return [
        'Login nativo da CLI.',
        ...(measured ? [`Medido: ${measured}.`] : []),
      ];
    case 'legacy':
      return [];
  }
}

/** Explicação em pt-BR do chip (tooltip), ou `null` quando não há chip. */
export function accountChoiceTooltip(
  receipt: AccountChoiceReceipt,
  options: AccountChoiceDisplayOptions = {},
): string | null {
  if (accountChoiceChipLabel(receipt) === null) return null;
  const now = options.now ?? Date.now();
  const measured = measuredPhrase(receipt.headroom, now, options.timeZone);
  const sentences = [
    ...leadSentences(receipt, measured),
    alternativesSentence(receipt),
    noteSentence(receipt.note),
  ].filter((sentence): sentence is string => sentence !== null);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/** `aria-label` do chip: a conta (o texto visível) seguida da explicação. */
export function accountChoiceAriaLabel(
  receipt: AccountChoiceReceipt,
  options: AccountChoiceDisplayOptions = {},
): string | null {
  const label = accountChoiceChipLabel(receipt);
  const tooltip = accountChoiceTooltip(receipt, options);
  if (label === null || tooltip === null) return null;
  return `Conta do pane: ${label}. ${tooltip}`;
}
