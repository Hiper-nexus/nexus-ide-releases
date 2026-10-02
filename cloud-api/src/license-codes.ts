import { hashToken } from './crypto.js';
import type { AccountRow, LicenseCodeRow } from './db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Base32 sem I, L, O e U (parecidos com 1/0 ou ambíguos): como 256 % 32 = 0, byte%32 não enviesa. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUPS = 3;
const GROUP_SIZE = 4;
/** Concessões sem período administrável ganham horizonte de ~100 anos: a regra
 * de entitlement só conta linhas com current_period_end > now. */
const PERPETUAL_MS = 100 * 365.25 * DAY_MS;

/** NEXUS-XXXX-XXXX-XXXX — 60 bits de entropia; o plaintext nunca é persistido. */
export function generateLicenseCode(random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const bytes = random(new Uint8Array(CODE_GROUPS * GROUP_SIZE));
  const body = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  const groups = Array.from({ length: CODE_GROUPS }, (_, index) => body.slice(index * GROUP_SIZE, (index + 1) * GROUP_SIZE));
  return `NEXUS-${groups.join('-')}`;
}

/** Maiúsculas e só alfanumérico — traços/espaços/caixa não mudam o código. O/I/L
 * nunca saem do gerador (ficam fora do alfabeto), então dobram para 0/1/1: erro comum de digitação. */
export function normalizeLicenseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1');
}

export function hashLicenseCode(normalized: string): Promise<string> {
  return hashToken(normalized);
}

async function codeByHash(db: D1Database, normalized: string): Promise<LicenseCodeRow | null> {
  const byHash = async (value: string) =>
    db.prepare('SELECT * FROM license_codes WHERE code_hash=?').bind(await hashLicenseCode(value)).first<LicenseCodeRow>();
  const direct = await byHash(normalized);
  // Quem digita só os caracteres centrais (sem o prefixo NEXUS-) também acerta.
  return direct ?? (normalized.startsWith('NEXUS') ? null : byHash(`NEXUS${normalized}`));
}

export interface MintFields {
  readonly createdBy: string | null;
  readonly periodDays: number | null;
  readonly maxUses: number;
  readonly note: string;
  readonly expiresAt: number | null;
}

/** Devolve o plaintext exatamente uma vez — só o hash vai para o banco. */
export async function mintLicenseCode(db: D1Database, fields: MintFields, now = Date.now()): Promise<{ id: string; code: string }> {
  const code = generateLicenseCode();
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO license_codes(id,code_hash,code_suffix,plan,period_days,max_uses,note,created_by,expires_at,created_at)
    VALUES(?,?,?,'pro',?,?,?,?,?,?)`)
    .bind(id, await hashLicenseCode(normalizeLicenseCode(code)), code.slice(-GROUP_SIZE), fields.periodDays, fields.maxUses, fields.note, fields.createdBy, fields.expiresAt, now).run();
  return { id, code };
}

export type RedeemOutcome = 'redeemed' | 'already' | 'invalid';

/** Resgata o código para a conta autenticada. Falhas genéricas são 'invalid'
 * sem dizer qual check caiu. A concessão materializa uma linha espelho em
 * subscriptions ('codegrant:<codeId>:<accountId>'), idempotente pelo UNIQUE. */
export async function redeemLicenseCode(db: D1Database, account: AccountRow, rawCode: string, now = Date.now()): Promise<RedeemOutcome> {
  const normalized = normalizeLicenseCode(rawCode);
  if (!normalized) return 'invalid';
  const code = await codeByHash(db, normalized);
  if (!code || code.revoked_at !== null || (code.expires_at !== null && code.expires_at <= now)) return 'invalid';

  let already = await db.prepare('SELECT code_id FROM license_redemptions WHERE code_id=? AND account_id=?').bind(code.id, account.id).first();
  if (!already) {
    try {
      // Cap de usos imposto no próprio INSERT: o COUNT é avaliado na mesma
      // transação da escrita — resgates concorrentes não estouram max_uses.
      const inserted = await db.prepare(`INSERT INTO license_redemptions(code_id,account_id,redeemed_at)
        SELECT ?,?,? WHERE (SELECT COUNT(*) FROM license_redemptions WHERE code_id=?) < (SELECT max_uses FROM license_codes WHERE id=? AND revoked_at IS NULL)`)
        .bind(code.id, account.id, now, code.id, code.id).run();
      if (!inserted.meta.changes) return 'invalid';
    } catch (error) {
      // PK (code_id,account_id): um resgate concorrente da mesma conta venceu
      // primeiro — segue como idempotente; qualquer outra falha sobe.
      already = await db.prepare('SELECT code_id FROM license_redemptions WHERE code_id=? AND account_id=?').bind(code.id, account.id).first();
      if (!already) throw error;
    }
  }

  const grantKey = `codegrant:${code.id}:${account.id}`;
  if (already) {
    // Re-resgate nunca ressuscita nem "confirma" uma concessão que já terminou: dizer sucesso aqui
    // devolveria uma licença inativa e o app mostraria "ativada" para sempre.
    const existing = await db.prepare('SELECT current_period_end AS end FROM subscriptions WHERE stripe_subscription_id=?').bind(grantKey).first<{ end: number | null }>();
    if (!existing || existing.end === null || existing.end <= now) return 'invalid';
  }

  const periodEnd = now + (code.period_days === null ? PERPETUAL_MS : code.period_days * DAY_MS);
  await db.batch([
    // O WHERE EXISTS fecha a corrida com a revogação: um código revogado depois de o slot ser tomado
    // não pode mais materializar a concessão (a revogação já apagou as concessões que existiam).
    db.prepare(`INSERT INTO subscriptions(id,owner_type,account_id,team_id,stripe_subscription_id,stripe_customer_id,plan,status,seats,current_period_end,grace_until,created_at,updated_at)
      SELECT ?,?,?,NULL,?,?,?,'active',1,?,NULL,?,? WHERE EXISTS(SELECT 1 FROM license_codes WHERE id=? AND revoked_at IS NULL)
      ON CONFLICT(stripe_subscription_id) DO NOTHING`)
      .bind(crypto.randomUUID(), 'account', account.id, grantKey, account.stripe_customer_id ?? 'code-grant', code.plan, periodEnd, now, now, code.id),
    // Mesmo cache que o webhook da Stripe mantém em accounts.plan.
    db.prepare("UPDATE accounts SET updated_at=?1,plan=CASE WHEN EXISTS(SELECT 1 FROM subscriptions s WHERE s.owner_type='account' AND s.account_id=accounts.id AND ((s.status IN('active','trialing') AND s.current_period_end>?1) OR (s.status='past_due' AND s.grace_until>?1))) THEN 'pro' ELSE 'free' END WHERE id=?2").bind(now, account.id),
  ]);
  // Se a revogação venceu a corrida, a concessão não existe: a resposta tem de ser a recusa genérica.
  const granted = await db.prepare('SELECT 1 AS ok FROM subscriptions WHERE stripe_subscription_id=?').bind(grantKey).first();
  if (!granted) return 'invalid';
  return already ? 'already' : 'redeemed';
}
