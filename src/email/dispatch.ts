import { configFrom, emailConfigured, type Config } from '../config.js';
import { CLASSIFIED, adminEmails } from '../classified.js';
import type { NoticeKind } from '../db/schema.js';
import { DAY_MS, ENDED_WINDOW_MS, FIRST_WARNING_MS, NOTICE_KINDS, WELCOME_WINDOW_MS, dueNotices, type DueNotice, type NoticeCandidate } from './notices.js';
import { createResendSender, oneClickUnsubscribeHeaders, type SendResult } from './resend.js';
import { renderNotice } from './templates.js';
import { buildUnsubscribeUrl, noticeToken } from './unsubscribe.js';

/** Teto de envios por execução do cron. Cada um é um subrequest, e o plano gratuito dá 50 por invocação. */
export const NOTICE_BATCH_LIMIT = 50;
/** As marcas vão ao banco em blocos: poucas consultas D1 por execução, e uma queda perde no máximo um bloco. */
const MARK_CHUNK = 10;
/** Perder uma marca só repete o envio, e a chave de idempotência do Resend segura o reenvio por 24 h. */
const MAX_CONSECUTIVE_FAILURES = 3;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DispatchOptions {
  readonly now?: number;
  readonly fetchFn?: FetchFn;
  /** Recebe uma linha por problema, sem destinatário, sem chave e sem corpo. */
  readonly log?: (message: string) => void;
}

export type DispatchStop = 'consecutive_failures' | 'auth';

export type DispatchResult =
  | { readonly skipped: 'disabled'; readonly candidates?: undefined; readonly sent?: undefined; readonly failed?: undefined; readonly stopped?: undefined }
  | { readonly skipped?: undefined; readonly candidates: number; readonly sent: number; readonly failed: number; readonly stopped: DispatchStop | null };

interface CandidateRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly created_at: number;
  readonly trial_expires_at: number | null;
  readonly notices_opt_out: number;
  readonly suspended_at: number | null;
  readonly is_admin: number;
  readonly situation: 'suspended' | 'active' | 'trial' | 'expired';
  readonly sent: string | null;
}

const sentSql = (kind: NoticeKind): string => `NOT EXISTS(SELECT 1 FROM account_notices n WHERE n.account_id=classified.id AND n.kind='${kind}')`;

/**
 * Uma consulta só. Reaproveita a classificação de acesso do painel (suspensa, paga/admin, teste vivo, expirado) e pré-filtra
 * pelas MESMAS janelas de `dueNotices`, tirando quem já recebeu cada tipo: assim o LIMIT nunca é gasto com quem não tem nada a receber.
 * ?1 agora, ?2 e-mails admin, ?3 limite do "terminou", ?4 agora+1d, ?5 agora+3d, ?6 limite das boas-vindas, ?7 teto.
 */
const CANDIDATES = `${CLASSIFIED}
SELECT id,email,name,created_at,trial_expires_at,notices_opt_out,suspended_at,is_admin,situation,
  (SELECT group_concat(n.kind) FROM account_notices n WHERE n.account_id=classified.id) AS sent
FROM classified
WHERE situation IN ('trial','expired') AND notices_opt_out=0 AND instr(email,'@')>1 AND (
  (trial_expires_at<=?1 AND trial_expires_at>=?3 AND ${sentSql('trial_ended')})
  OR (trial_expires_at>?1 AND trial_expires_at<=?4 AND ${sentSql('trial_ending_1d')})
  OR (trial_expires_at>?4 AND trial_expires_at<=?5 AND ${sentSql('trial_ending_3d')})
  OR (created_at>=?6 AND created_at<=?1 AND (trial_expires_at IS NULL OR trial_expires_at>?5 OR trial_expires_at<?3) AND ${sentSql('welcome')})
)
ORDER BY CASE WHEN trial_expires_at>?1 AND trial_expires_at<=?4 THEN 0 WHEN trial_expires_at<=?1 THEN 1 WHEN trial_expires_at<=?5 THEN 2 ELSE 3 END,
  COALESCE(trial_expires_at,created_at),id
LIMIT ?7`;

function toCandidate(row: CandidateRow): NoticeCandidate {
  const sent = (row.sent ?? '').split(',').filter((kind): kind is NoticeKind => (NOTICE_KINDS as readonly string[]).includes(kind));
  return {
    id: row.id, email: row.email, name: row.name, createdAt: row.created_at, suspendedAt: row.suspended_at, trialExpiresAt: row.trial_expires_at,
    noticesOptOut: row.notices_opt_out === 1, paid: row.situation === 'active', isAdmin: row.is_admin === 1, sentKinds: sent,
  };
}

function daysLeft(trialEndsAt: string | null, now: number): number {
  if (trialEndsAt === null) return 0;
  return Math.max(1, Math.ceil((Date.parse(trialEndsAt) - now) / DAY_MS));
}

function template(config: Config, due: Pick<DueNotice, 'name' | 'trialEndsAt'>, unsubscribeUrl: string, now: number) {
  return { name: due.name, trialEndsAt: due.trialEndsAt, daysLeft: daysLeft(due.trialEndsAt, now), unsubscribeUrl, trialDays: config.TRIAL_DAYS, maxAgents: config.TRIAL_MAX_AGENTS };
}

/**
 * Envia os avisos de teste que estão na hora. Desligado (interruptor, chave ou segredo faltando) não faz nada:
 * nenhuma consulta, nenhuma chamada, nenhuma marca.
 */
export async function sendDueNotices(env: { readonly DB: D1Database }, options: DispatchOptions = {}): Promise<DispatchResult> {
  const config = configFrom(env);
  if (!emailConfigured(config)) return { skipped: 'disabled' };
  const now = options.now ?? Date.now();
  const log = options.log ?? ((message: string) => console.error(message));
  const db = env.DB;

  const rows = await db.prepare(CANDIDATES)
    .bind(now, adminEmails(config), now - ENDED_WINDOW_MS, now + DAY_MS, now + FIRST_WARNING_MS, now - WELCOME_WINDOW_MS, NOTICE_BATCH_LIMIT)
    .all<CandidateRow>();
  const due = dueNotices(rows.results.map(toCandidate), now);

  const sender = createResendSender({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM, ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }) });
  let pending: D1PreparedStatement[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await db.batch(pending);
    pending = [];
  };

  let sent = 0, failed = 0, consecutive = 0, loggedRefusal = false;
  let stopped: DispatchStop | null = null;
  let failure: unknown;
  try {
    for (const notice of due) {
      const unsubscribeUrl = buildUnsubscribeUrl(config.PUBLIC_BASE_URL, notice.accountId, await noticeToken(config.NOTICE_SECRET, notice.accountId));
      const rendered = renderNotice(notice.kind, template(config, notice, unsubscribeUrl, now));
      const result = await sender.send({
        to: notice.email, subject: rendered.subject, html: rendered.html, text: rendered.text,
        idempotencyKey: `${notice.accountId}:${notice.kind}`, headers: oneClickUnsubscribeHeaders(unsubscribeUrl),
      });
      if (result.ok) {
        sent += 1; consecutive = 0;
        pending.push(db.prepare('INSERT OR IGNORE INTO account_notices(account_id,kind,sent_at,provider_id) VALUES(?,?,?,?)').bind(notice.accountId, notice.kind, now, result.id));
        if (pending.length >= MARK_CHUNK) await flush();
        continue;
      }
      failed += 1;
      if (result.retryable) {
        consecutive += 1;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) { stopped = 'consecutive_failures'; log(`nexus-cloud-api: lote de avisos interrompido após ${MAX_CONSECUTIVE_FAILURES} falhas seguidas do Resend (${result.reason})`); break; }
        continue;
      }
      if (!loggedRefusal) { loggedRefusal = true; log(`nexus-cloud-api: aviso recusado pelo Resend sem nova tentativa (${result.reason})`); }
      if (result.status === 401 || result.status === 403) { stopped = 'auth'; break; }
    }
  } catch (error) { failure = error; }
  try { await flush(); } catch (error) { failure ??= error; }
  if (failure !== undefined) throw failure;
  return { candidates: rows.results.length, sent, failed, stopped };
}

/** Envio de teste do painel admin: o aviso de 3 dias, só para o endereço informado, com descadastro válido da própria conta. */
export async function sendTestNotice(env: unknown, input: { readonly accountId: string; readonly to: string; readonly name: string | null }, fetchFn?: FetchFn, now = Date.now()): Promise<SendResult> {
  const config = configFrom(env);
  const unsubscribeUrl = buildUnsubscribeUrl(config.PUBLIC_BASE_URL, input.accountId, await noticeToken(config.NOTICE_SECRET, input.accountId));
  const sender = createResendSender({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM, ...(fetchFn === undefined ? {} : { fetchFn }) });
  const rendered = renderNotice('trial_ending_3d', template(config, { name: input.name, trialEndsAt: new Date(now + 3 * DAY_MS).toISOString() }, unsubscribeUrl, now));
  return sender.send({
    to: input.to, subject: rendered.subject, html: rendered.html, text: rendered.text,
    idempotencyKey: `test-notice:${crypto.randomUUID()}`, headers: oneClickUnsubscribeHeaders(unsubscribeUrl),
  });
}
