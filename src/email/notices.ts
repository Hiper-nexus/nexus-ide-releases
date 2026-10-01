import type { NoticeKind } from '../db/schema.js';

/** Quais contas devem receber qual aviso agora. Puro: o relógio e o que já foi enviado entram por parâmetro. */
export const NOTICE_KINDS = ['welcome', 'trial_ending_3d', 'trial_ending_1d', 'trial_ended'] as const satisfies readonly NoticeKind[];

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ENDED_WINDOW_MS = 7 * DAY_MS;
/** Quanto tempo depois da criação da conta as boas-vindas ainda valem. */
export const WELCOME_WINDOW_MS = DAY_MS;
/** Até quanto antes do fim o primeiro aviso sai. */
export const FIRST_WARNING_MS = 3 * DAY_MS;
/** Do mais urgente ao menos urgente: só o primeiro que vale agora é considerado. */
const URGENCY: readonly NoticeKind[] = ['trial_ended', 'trial_ending_1d', 'trial_ending_3d', 'welcome'];

export interface NoticeCandidate {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly createdAt: number;
  readonly suspendedAt: number | null;
  readonly trialExpiresAt: number | null;
  readonly noticesOptOut: boolean;
  /** Assinatura ativa ou concessão (incl. código de licença), calculada pela mesma regra de accountAccess. */
  readonly paid: boolean;
  readonly isAdmin: boolean;
  /** Tipos que já saíram para esta conta. */
  readonly sentKinds: readonly NoticeKind[];
}

export interface DueNotice {
  readonly accountId: string;
  readonly email: string;
  readonly name: string | null;
  readonly kind: NoticeKind;
  readonly trialEndsAt: string | null;
}

const ADDRESS_PART = String.raw`[^\s@<>"',;:()\[\]\\]`;
const EMAIL = new RegExp(`^${ADDRESS_PART}+@${ADDRESS_PART}+\\.${ADDRESS_PART}+$`);

/** Conservador de propósito: o login grava `provedor:id` quando não há e-mail verificado, e isso nunca é endereço. */
export function isDeliverableEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}

/** Caracteres que um endereço entregável nunca tem (os de `ADDRESS_PART`, em GLOB para o SQLite). O `]` vem primeiro para valer como literal. */
export const FORBIDDEN_ADDRESS_GLOB = '*[][ <>",;:()\'\\\t\n\r]*';

/**
 * Espelho em SQL de `isDeliverableEmail`, que o D1 não executa: sem ele o LIMIT do despacho seria gasto com endereços que o filtro em memória
 * descarta depois, e eles voltariam toda hora. Tem de ser igual ou mais frouxo que a regex, nunca mais estrito (senão some quem é válido).
 * `forbiddenParam` é o placeholder que recebe FORBIDDEN_ADDRESS_GLOB.
 */
export function deliverableEmailSql(column: string, forbiddenParam: string): string {
  return `(length(${column})<=254 AND ${column} GLOB '?*@?*.?*' AND length(${column})-length(replace(${column},'@',''))=1 AND ${column} NOT GLOB ${forbiddenParam})`;
}

function candidateKinds(row: NoticeCandidate, now: number): Set<NoticeKind> {
  const kinds = new Set<NoticeKind>();
  const ends = row.trialExpiresAt;
  if (typeof ends === 'number' && Number.isFinite(ends)) {
    const remaining = ends - now;
    if (remaining <= 0) { if (-remaining <= ENDED_WINDOW_MS) kinds.add('trial_ended'); }
    else if (remaining <= DAY_MS) kinds.add('trial_ending_1d');
    else if (remaining <= FIRST_WARNING_MS) kinds.add('trial_ending_3d');
  }
  const age = now - row.createdAt;
  if (Number.isFinite(age) && age >= 0 && age <= WELCOME_WINDOW_MS) kinds.add('welcome');
  return kinds;
}

export function dueNotices(rows: readonly NoticeCandidate[], now: number): DueNotice[] {
  if (!Number.isFinite(now)) return [];
  const due: DueNotice[] = [];
  for (const row of rows) {
    if (row.suspendedAt !== null || row.paid || row.isAdmin || row.noticesOptOut || !isDeliverableEmail(row.email)) continue;
    const candidates = candidateKinds(row, now);
    const kind = URGENCY.find(value => candidates.has(value));
    if (kind === undefined || row.sentKinds.includes(kind)) continue;
    due.push({
      accountId: row.id, email: row.email, name: row.name, kind,
      trialEndsAt: row.trialExpiresAt === null || !Number.isFinite(row.trialExpiresAt) ? null : new Date(row.trialExpiresAt).toISOString(),
    });
  }
  return due;
}
