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
 * `g•••@l•••.com.br` (1º char do local + 1º char do domínio + sufixo público
 * do domínio). O sufixo nunca guarda subdomínios: 2 rótulos → só o último
 * (`gmail.com` → `.com`); ≥ 3 rótulos e o penúltimo com ≤ 3 chars → os dois
 * últimos (`lupygo.com.br` → `.com.br`, `x.co.uk` → `.co.uk`); senão só o
 * último (`mail.example.com` → `.com`); 1 rótulo → sem sufixo. Não-e-mail
 * vira `ab•••yz` quando > 6 chars, senão `•••`. Nunca inclui id,
 * fingerprint nem token.
 */
export function maskAccountLabel(label: string): string {
  const trimmed = label.trim();
  const at = trimmed.indexOf('@');
  if (at > 0 && at < trimmed.length - 1) {
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    const labels = domain.split('.');
    let suffix = '';
    if (labels.length === 2) {
      suffix = `.${labels[1]}`;
    } else if (labels.length >= 3) {
      const secondLast = labels[labels.length - 2];
      suffix =
        secondLast.length <= 3
          ? `.${secondLast}.${labels[labels.length - 1]}`
          : `.${labels[labels.length - 1]}`;
    }
    return `${local[0]}•••@${domain[0]}•••${suffix}`;
  }
  if (trimmed.length > 6) {
    return `${trimmed.slice(0, 2)}•••${trimmed.slice(-2)}`;
  }
  return '•••';
}

/* ------------------------------------------------------------------------ *
 * Saneamento na fronteira Main → renderer.
 *
 * O recibo guardado já nasce mascarado (`maskAccountLabel` na construção), mas
 * o que cruza o IPC para a PESSOA não pode depender de todo produtor lembrar
 * disso: o parser abaixo é uma lista de permissão que reconstrói o recibo do
 * zero. Chave desconhecida (id, fingerprint, token, e-mail cru) não passa;
 * rótulo é remascarado (idempotente sobre o já mascarado); texto livre
 * (`window`, `note`) perde controle/bidi, mascara e-mail cru e tem teto.
 * ------------------------------------------------------------------------ */

export const RECEIPT_WINDOW_MAX_CHARS = 32;
export const RECEIPT_NOTE_MAX_CHARS = 240;
export const RECEIPT_ALTERNATIVES_MAX = 100;

const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ReceiptAccountMode = NonNullable<AccountChoiceReceipt['account']>['mode'];
type AlternativeSkipReason = AccountChoiceAlternative['skipped'];

const RECEIPT_SOURCES: ReadonlySet<string> = new Set<AccountChoiceSource>([
  'pinned',
  'headroom-rule',
  'active',
  'active-fallback',
  'native',
  'legacy',
]);
const ACCOUNT_MODES: ReadonlySet<string> = new Set<ReceiptAccountMode>([
  'subscription',
  'api_key',
  'unknown',
]);
const SKIPPED_REASONS: ReadonlySet<string> = new Set<AlternativeSkipReason>([
  'cooldown',
  'no-credential',
  'less-headroom',
  'unknown-quota',
]);

// Controles C0/C1 viram espaço; marcas bidi/largura zero somem (spoof de tooltip).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE_CHARS = /[​-‏‪-‮⁦-⁩﻿]/g;
const EMAIL_LIKE = /[^\s"'`<>()[\]{},;]+@[^\s"'`<>()[\]{},;]+/g;
const TRAILING_PUNCTUATION = /[.:!?]+$/;

/** Texto livre seguro para a UI: sem controle, e-mail mascarado, com teto. */
export function sanitizeReceiptText(text: string, maxChars: number): string {
  const cleaned = text
    .replace(INVISIBLE_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(EMAIL_LIKE, (match) => {
      const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
      const core = trailing ? match.slice(0, -trailing.length) : match;
      return `${maskAccountLabel(core)}${trailing}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxChars).join('').trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function percentOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : null;
}

function scoreOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function epochOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function windowOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return sanitizeReceiptText(value, RECEIPT_WINDOW_MAX_CHARS) || null;
}

function parseAlternative(raw: unknown): AccountChoiceAlternative | null {
  if (!isPlainRecord(raw)) return null;
  const { label, skipped } = raw;
  if (typeof label !== 'string') return null;
  if (typeof skipped !== 'string' || !SKIPPED_REASONS.has(skipped)) return null;
  return {
    label: maskAccountLabel(label),
    usedPct: percentOrNull(raw.usedPct),
    window: windowOrNull(raw.window),
    resetsAt: epochOrNull(raw.resetsAt),
    skipped: skipped as AlternativeSkipReason,
  };
}

function parseHeadroom(raw: unknown): AccountHeadroom | null {
  if (!isPlainRecord(raw)) return null;
  return {
    usedPct: percentOrNull(raw.usedPct),
    window: windowOrNull(raw.window),
    resetsAt: epochOrNull(raw.resetsAt),
    score: scoreOrNull(raw.score),
  };
}

/** `undefined` = conta malformada (recusa o recibo); `null` = sem conta. */
function parseAccount(raw: unknown): AccountChoiceReceipt['account'] | undefined {
  if (raw === null || raw === undefined) return null;
  if (!isPlainRecord(raw) || typeof raw.label !== 'string') return undefined;
  const mode =
    typeof raw.mode === 'string' && ACCOUNT_MODES.has(raw.mode)
      ? (raw.mode as ReceiptAccountMode)
      : 'unknown';
  return { label: maskAccountLabel(raw.label), mode };
}

/**
 * Reconstrói o recibo a partir de dado não confiável (IPC) ou devolve `null`.
 * Nunca lança. A saída é sempre uma cópia nova só com campos da lista de
 * permissão — chave extra do recibo guardado nunca chega à interface.
 */
export function parseAccountChoiceReceipt(raw: unknown): AccountChoiceReceipt | null {
  try {
    if (!isPlainRecord(raw)) return null;
    const { adapterId, source, decidedAt } = raw;
    if (typeof adapterId !== 'string' || !ADAPTER_ID_PATTERN.test(adapterId)) return null;
    if (typeof source !== 'string' || !RECEIPT_SOURCES.has(source)) return null;
    if (typeof decidedAt !== 'number' || !Number.isFinite(decidedAt)) return null;
    const account = parseAccount(raw.account);
    if (account === undefined) return null;

    const alternatives = Array.isArray(raw.alternatives)
      ? raw.alternatives
          .slice(0, RECEIPT_ALTERNATIVES_MAX)
          .map(parseAlternative)
          .filter((alt): alt is AccountChoiceAlternative => alt !== null)
      : [];
    const note =
      typeof raw.note === 'string'
        ? sanitizeReceiptText(raw.note, RECEIPT_NOTE_MAX_CHARS)
        : '';

    return {
      adapterId,
      source: source as AccountChoiceSource,
      account,
      headroom: parseHeadroom(raw.headroom),
      alternatives,
      decidedAt,
      ...(note ? { note } : {}),
    };
  } catch {
    return null;
  }
}
