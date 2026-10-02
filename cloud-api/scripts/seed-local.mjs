// Seeds the LOCAL D1 used by `wrangler dev --local` with one account in each
// situation and a signed-in web session for an administrator, so the account
// page and the admin panel can be exercised without real OAuth or Stripe.
// Never run against a remote database: it only prints SQL and cookie values.
//
//   node scripts/seed-local.mjs > .wrangler/seed-local.sql
//   npx wrangler d1 execute DB --local --file .wrangler/seed-local.sql
//
// The cookie values are printed to stderr. ADMIN_EMAILS in .dev.vars must
// contain admin@local.test for the admin session to be authorized.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const insert = (table, row) => `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(quote).join(',')});`;

const accounts = [
  { id: 'local-admin', email: 'admin@local.test', name: 'Admin Local', role: 'admin', trial: 15 },
  { id: 'local-trial', email: 'teste@local.test', name: 'Conta em Teste', role: 'user', trial: 9 },
  { id: 'local-expired', email: 'encerrado@local.test', name: 'Teste Encerrado', role: 'user', trial: -3 },
  { id: 'local-pro', email: 'assinante@local.test', name: 'Assinante Pro', role: 'user', trial: -20, customer: 'cus_local_pro', subscription: 'active' },
  { id: 'local-suspended', email: 'suspensa@local.test', name: 'Conta Suspensa', role: 'user', trial: -20, customer: 'cus_local_suspended', subscription: 'active', suspended: 'chargeback de exemplo' },
  { id: 'local-pastdue', email: 'atrasado@local.test', name: 'Pagamento Pendente', role: 'user', trial: -20, customer: 'cus_local_pastdue', subscription: 'past_due' },
];

const sql = ["DELETE FROM accounts WHERE id LIKE 'local-%';"];
for (const account of accounts) {
  const expires = now + account.trial * DAY;
  sql.push(insert('accounts', {
    id: account.id, email: account.email, name: account.name, role: account.role, created_at: now, updated_at: now,
    trial_started_at: Math.min(now, expires) - DAY, trial_expires_at: expires, last_seen_at: now,
    stripe_customer_id: account.customer ?? null, suspended_at: account.suspended ? now : null, suspension_reason: account.suspended ?? null,
  }));
  sql.push(insert('identities', { id: randomUUID(), account_id: account.id, provider: 'google', provider_user_id: `subject-${account.id}`, email: account.email, email_verified: 1, created_at: now }));
  if (account.subscription) {
    sql.push(insert('subscriptions', {
      id: randomUUID(), owner_type: 'account', account_id: account.id, stripe_subscription_id: `sub_${account.id}`, stripe_customer_id: account.customer,
      plan: 'pro', status: account.subscription, seats: 1, current_period_end: now + 20 * DAY, grace_until: account.subscription === 'past_due' ? now + 5 * DAY : null, created_at: now, updated_at: now,
    }));
  }
}

const sessions = {};
for (const accountId of ['local-admin', 'local-trial', 'local-suspended']) {
  const session = token(), refresh = token(), csrf = token();
  sql.push(insert('sessions', { id: randomUUID(), account_id: accountId, token_hash: hash(session), expires_at: now + DAY, created_at: now, csrf_hash: hash(csrf), channel: 'web' }));
  sql.push(insert('refresh_tokens', { id: randomUUID(), account_id: accountId, token_hash: hash(refresh), expires_at: now + 30 * DAY, created_at: now, channel: 'web' }));
  sessions[accountId] = { '__Host-nexus_session': session, '__Host-nexus_refresh': refresh, '__Host-nexus_csrf': csrf };
}

process.stdout.write(sql.join('\n') + '\n');
process.stderr.write(JSON.stringify(sessions, null, 2) + '\n');
