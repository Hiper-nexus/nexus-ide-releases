import { HTTPException } from 'hono/http-exception';
import {
  BILLING_INTERVALS, COUPON_MESSAGES, canonicalIntervals, cheapestAmount, intervalSpec, isBillingInterval,
  normalizeCouponCode, type BillingInterval,
} from './billing-catalog.js';

export type CouponKind = 'percent' | 'amount';

export interface DiscountCouponRow {
  readonly id: string;
  readonly code: string;
  readonly kind: CouponKind;
  readonly value: number;
  readonly expires_at: number | null;
  readonly max_redemptions: number | null;
  readonly redeemed_count: number;
  readonly intervals: string;
  readonly active: number;
  readonly stripe_coupon_id: string | null;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly disabled_at: number | null;
  readonly updated_at: number;
}

export interface CouponView {
  readonly id: string;
  readonly code: string;
  readonly kind: CouponKind;
  readonly value: number;
  readonly expiresAt: string | null;
  readonly maxRedemptions: number | null;
  readonly uses: number;
  readonly intervals: BillingInterval[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}

export interface NewCoupon {
  readonly code: string;
  readonly kind: CouponKind;
  readonly value: number;
  readonly intervals: readonly string[];
  readonly expiresAt: number | null;
  readonly maxRedemptions: number | null;
  readonly createdBy: string;
}

function intervalsOf(raw: string): BillingInterval[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return BILLING_INTERVALS.filter(id => parsed.includes(id));
  } catch { return []; }
}

export function couponView(row: DiscountCouponRow): CouponView {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    value: row.value,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    maxRedemptions: row.max_redemptions,
    uses: row.redeemed_count,
    intervals: intervalsOf(row.intervals),
    active: row.active === 1,
    createdAt: new Date(row.created_at).toISOString(),
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at).toISOString(),
  };
}

/** Recusa o cupom antes de qualquer cliente ou sessão na Stripe. */
export function rejectCoupon(row: DiscountCouponRow | null, interval: BillingInterval, now: number): DiscountCouponRow {
  if (!row) throw new HTTPException(400, { message: COUPON_MESSAGES.invalid });
  if (row.active !== 1) throw new HTTPException(400, { message: COUPON_MESSAGES.inactive });
  if (row.expires_at !== null && row.expires_at <= now) throw new HTTPException(400, { message: COUPON_MESSAGES.expired });
  if (row.max_redemptions !== null && row.redeemed_count >= row.max_redemptions) throw new HTTPException(400, { message: COUPON_MESSAGES.usedUp });
  const intervals = intervalsOf(row.intervals);
  if (!intervals.includes(interval)) throw new HTTPException(400, { message: COUPON_MESSAGES.wrongInterval });
  if (row.kind === 'amount' && row.value > intervalSpec(interval).amount) throw new HTTPException(400, { message: COUPON_MESSAGES.tooLarge });
  return row;
}

export async function findCouponByCode(db: D1Database, raw: string): Promise<DiscountCouponRow | null> {
  const code = normalizeCouponCode(raw);
  if (!code) return null;
  return db.prepare('SELECT * FROM discount_coupons WHERE code=?').bind(code).first<DiscountCouponRow>();
}

export async function insertCoupon(db: D1Database, input: NewCoupon, now: number): Promise<CouponView> {
  const code = normalizeCouponCode(input.code);
  if (!code) throw new HTTPException(400, { message: COUPON_MESSAGES.badCode });
  const intervals = canonicalIntervals(input.intervals);
  if (!intervals) throw new HTTPException(400, { message: 'Escolha ao menos um período válido para o cupom.' });
  if (input.kind === 'percent' && (input.value < 1 || input.value > 100)) throw new HTTPException(400, { message: COUPON_MESSAGES.badPercent });
  if (input.kind === 'amount' && input.value > cheapestAmount(intervals)) throw new HTTPException(400, { message: COUPON_MESSAGES.tooLarge });
  if (input.expiresAt !== null && input.expiresAt <= now) throw new HTTPException(400, { message: 'A validade do cupom precisa ser uma data futura.' });
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO discount_coupons(id,code,kind,value,expires_at,max_redemptions,intervals,active,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,1,?,?,?)`)
      .bind(id, code, input.kind, input.value, input.expiresAt, input.maxRedemptions, JSON.stringify(intervals), input.createdBy, now, now).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HTTPException(409, { message: COUPON_MESSAGES.duplicate });
    throw error;
  }
  const row = await db.prepare('SELECT * FROM discount_coupons WHERE id=?').bind(id).first<DiscountCouponRow>();
  if (!row) throw new HTTPException(500, { message: 'Erro interno. Tente novamente.' });
  return couponView(row);
}

export async function listCoupons(db: D1Database): Promise<CouponView[]> {
  const rows = await db.prepare('SELECT * FROM discount_coupons ORDER BY created_at DESC LIMIT 200').all<DiscountCouponRow>();
  return rows.results.map(couponView);
}

export async function disableCoupon(db: D1Database, id: string, now: number): Promise<void> {
  const existing = await db.prepare('SELECT id, active FROM discount_coupons WHERE id=?').bind(id).first<{ id: string; active: number }>();
  if (!existing) throw new HTTPException(404, { message: COUPON_MESSAGES.notFound });
  if (existing.active !== 1) throw new HTTPException(409, { message: COUPON_MESSAGES.alreadyOff });
  const changed = await db.prepare('UPDATE discount_coupons SET active=0, disabled_at=?, updated_at=? WHERE id=? AND active=1 RETURNING id')
    .bind(now, now, id).first<{ id: string }>();
  if (!changed) throw new HTTPException(409, { message: COUPON_MESSAGES.alreadyOff });
}

/** Conta o uso uma vez por assinatura. Repetir o webhook não aumenta o número. */
export function redemptionStatements(db: D1Database, couponStripeIds: readonly string[], accountId: string, interval: BillingInterval, subscriptionId: string, at: number): D1PreparedStatement[] {
  if (!isBillingInterval(interval)) return [];
  const statements: D1PreparedStatement[] = [];
  for (const stripeCouponId of couponStripeIds) {
    if (!stripeCouponId) continue;
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO coupon_redemptions(id,coupon_id,account_id,interval,stripe_subscription_id,created_at)
        SELECT ?,c.id,?,?,?,? FROM discount_coupons c WHERE c.stripe_coupon_id=?`)
        .bind(crypto.randomUUID(), accountId, interval, subscriptionId, at, stripeCouponId),
      db.prepare(`UPDATE discount_coupons SET redeemed_count=(SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id=discount_coupons.id), updated_at=?
        WHERE stripe_coupon_id=?`).bind(at, stripeCouponId),
    );
  }
  return statements;
}
