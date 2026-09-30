import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrationPath = new URL('../migrations/0001_core.sql', import.meta.url);
const NOW = 1_790_766_000_123;
const FUTURE = NOW + 60_000;

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(migrationPath, 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_trial_admin.sql', import.meta.url), 'utf8'));
  return db;
}

function account(db, email = `${randomUUID()}@example.test`) {
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run(id, email);
  return id;
}

function identity(db, accountId, subject = randomUUID(), provider = 'github') {
  db.prepare(`INSERT INTO identities
    (id, account_id, provider, provider_user_id) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), accountId, provider, subject);
}

function project(db, accountId, projectId = 'same-project') {
  db.prepare(`INSERT INTO sync_projects
    (account_id, project_id, revision, entities, entity_count, state_bytes, updated_at)
    VALUES (?, ?, 1, '[]', 0, 2, ?)`)
    .run(accountId, projectId, NOW);
}

test('schema metadata records version without claiming PostgreSQL import', (t) => {
  const db = database(t);
  assert.equal(db.prepare("SELECT value FROM system_metadata WHERE key = 'schema_version'").get().value, '2');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_metadata WHERE key LIKE 'import%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 0);
});

test('OAuth provider and subject identify exactly one account', (t) => {
  const db = database(t);
  const first = account(db);
  const second = account(db);
  identity(db, first, 'subject');
  assert.throws(() => identity(db, second, 'subject'), /UNIQUE constraint failed/);
  identity(db, second, 'subject', 'google');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 2);
});

test('failed identity insertion rolls back account creation in an atomic batch', (t) => {
  const db = database(t);
  identity(db, account(db), 'existing-subject');
  const newId = randomUUID();
  // SQLite transaction models D1.batch atomicity; no network/D1 claim is made.
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run(newId, 'loser@example.test');
    assert.throws(() => identity(db, newId, 'existing-subject'), /UNIQUE constraint failed/);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = ?').get(newId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 1);
});

test('identical project and schedule IDs remain isolated by account', (t) => {
  const db = database(t);
  const ids = [account(db), account(db)];
  for (const id of ids) {
    project(db, id);
    db.prepare(`INSERT INTO cron_schedules
      (account_id, project_id, schedule_id, version, definition, definition_hash, status)
      VALUES (?, 'same-project', 'same-schedule', 1, '{}', 'definition-hash', 'active')`).run(id);
    db.prepare(`INSERT INTO cron_leases
      (account_id, project_id, schedule_id, occurrence_at, version, expires_at)
      VALUES (?, 'same-project', 'same-schedule', ?, 1, ?)`).run(id, NOW, FUTURE);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_projects').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cron_schedules').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cron_leases').get().n, 2);
  assert.throws(() => project(db, ids[0]), /UNIQUE constraint failed/);
});

test('conditional refresh consumption has exactly one winner', (t) => {
  const db = database(t);
  const id = account(db);
  db.prepare(`INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at)
    VALUES (?, ?, 'refresh-hash', ?)`).run(randomUUID(), id, FUTURE);
  const consume = db.prepare(`UPDATE refresh_tokens SET used_at = ?
    WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL
    AND expires_at > ? AND channel = 'desktop' RETURNING account_id`);
  assert.equal(consume.all(NOW, 'refresh-hash', NOW).length, 1);
  assert.equal(consume.all(NOW + 1, 'refresh-hash', NOW + 1).length, 0);
  assert.equal(db.prepare("SELECT used_at FROM refresh_tokens WHERE token_hash = 'refresh-hash'").get().used_at, NOW);
});

test('desktop and web auth share session tables with explicit channels', (t) => {
  const db = database(t);
  const id = account(db);
  db.prepare(`INSERT INTO sessions (id, account_id, token_hash, expires_at)
    VALUES (?, ?, 'desktop-hash', ?)`).run(randomUUID(), id, FUTURE);
  db.prepare(`INSERT INTO sessions (id, account_id, token_hash, expires_at, channel, csrf_hash)
    VALUES (?, ?, 'web-hash', ?, 'web', 'csrf-hash')`).run(randomUUID(), id, FUTURE);
  const rows = db.prepare('SELECT channel, csrf_hash FROM sessions ORDER BY channel').all();
  assert.deepEqual(rows.map((r) => [r.channel, r.csrf_hash]), [['desktop', null], ['web', 'csrf-hash']]);
  assert.throws(() => db.prepare(`INSERT INTO sessions (id, account_id, token_hash, expires_at, channel)
    VALUES (?, ?, 'bad-channel', ?, 'mobile')`).run(randomUUID(), id, FUTURE), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at, channel)
    VALUES (?, ?, 'bad-refresh', ?, 'mobile')`).run(randomUUID(), id, FUTURE), /CHECK constraint failed/);
});

test('OAuth states retain desktop defaults and allow nullable web app state', (t) => {
  const db = database(t);
  db.prepare(`INSERT INTO oauth_states (state, provider, code_verifier, app_state, expires_at)
    VALUES ('desktop', 'github', 'verifier', 'app-nonce', ?)`).run(FUTURE);
  db.prepare(`INSERT INTO oauth_states (state, provider, code_verifier, flow, web_state_hash, expires_at)
    VALUES ('web', 'google', 'verifier', 'web', 'web-state-hash', ?)`).run(FUTURE);
  assert.equal(db.prepare("SELECT flow FROM oauth_states WHERE state = 'desktop'").get().flow, 'desktop');
  assert.equal(db.prepare("SELECT app_state FROM oauth_states WHERE state = 'web'").get().app_state, null);
  assert.throws(() => db.prepare(`INSERT INTO oauth_states
    (state, provider, code_verifier, flow, expires_at) VALUES ('bad', 'github', 'v', 'mobile', ?)`).run(FUTURE), /CHECK constraint failed/);
});

test('each account can belong to exactly one team', (t) => {
  const db = database(t);
  const owner = account(db);
  const member = account(db);
  const teamIds = [randomUUID(), randomUUID()];
  for (const id of teamIds) db.prepare('INSERT INTO teams (id, name, owner_account_id) VALUES (?, ?, ?)').run(id, id, owner);
  db.prepare("INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'member')").run(teamIds[0], member);
  assert.throws(() => db.prepare("INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'member')").run(teamIds[1], member), /UNIQUE constraint failed/);
});

test('enum, boolean, numeric and JSON constraints reject invalid persisted values', (t) => {
  const db = database(t);
  const id = account(db);
  assert.throws(() => db.prepare("UPDATE accounts SET plan = 'enterprise' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.throws(() => identity(db, id, 'subject', 'untrusted'), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO identities
    (id, account_id, provider, provider_user_id, email_verified) VALUES (?, ?, 'github', 'bool', 2)`)
    .run(randomUUID(), id), /CHECK constraint failed/);
  const teamId = randomUUID();
  db.prepare('INSERT INTO teams (id, name, owner_account_id) VALUES (?, ?, ?)').run(teamId, 'team', id);
  assert.throws(() => db.prepare("INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'admin')")
    .run(teamId, id), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO subscriptions
    (id, owner_type, stripe_subscription_id, stripe_customer_id, plan, status)
    VALUES (?, 'invalid', 'sub', 'cus', 'pro', 'active')`).run(randomUUID()), /CHECK constraint failed/);
  assert.throws(() => db.prepare("INSERT INTO stripe_events (event_id, type, payload) VALUES ('evt', 'type', 'not-json')").run(), /CHECK constraint failed/);
  project(db, id);
  for (const [column, value] of [['entities', '{broken'], ['revision', 0], ['entity_count', 1001], ['state_bytes', 196609]]) {
    assert.throws(() => db.prepare(`UPDATE sync_projects SET ${column} = ? WHERE account_id = ?`).run(value, id), /CHECK constraint failed/);
  }
  assert.throws(() => db.prepare(`INSERT INTO cron_schedules
    (account_id, project_id, schedule_id, version, definition, definition_hash, status)
    VALUES (?, 'p', 's', 1, '{}', 'hash', 'invalid')`).run(id), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO cron_schedules
    (account_id, project_id, schedule_id, version, definition, definition_hash, status)
    VALUES (?, 'p', 's', 1, 'invalid-json', 'hash', 'active')`).run(id), /CHECK constraint failed/);
});

test('foreign keys reject orphan identities and account deletion preserves unrelated data', (t) => {
  const db = database(t);
  assert.throws(() => identity(db, randomUUID()), /FOREIGN KEY constraint failed/);
  const first = account(db);
  const second = account(db);
  for (const id of [first, second]) {
    identity(db, id);
    project(db, id);
    db.prepare('INSERT INTO sessions (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), id, `session-${id}`, FUTURE);
    db.prepare('INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), id, `refresh-${id}`, FUTURE);
    db.prepare('INSERT INTO auth_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)').run(`code-${id}`, id, FUTURE);
    const teamId = randomUUID();
    db.prepare('INSERT INTO teams (id, name, owner_account_id) VALUES (?, ?, ?)').run(teamId, id, id);
    db.prepare("INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'owner')").run(teamId, id);
    db.prepare(`INSERT INTO team_invites (code_hash, code_prefix, team_id, created_by, expires_at)
      VALUES (?, 'CODE', ?, ?, ?)`).run(`invite-${id}`, teamId, id, FUTURE);
    db.prepare(`INSERT INTO subscriptions
      (id, owner_type, account_id, stripe_subscription_id, stripe_customer_id, plan, status)
      VALUES (?, 'account', ?, ?, ?, 'pro', 'active')`).run(randomUUID(), id, `sub-${id}`, `cus-${id}`);
    db.prepare(`INSERT INTO subscriptions
      (id, owner_type, team_id, stripe_subscription_id, stripe_customer_id, plan, status)
      VALUES (?, 'team', ?, ?, ?, 'team', 'active')`).run(randomUUID(), teamId, `team-sub-${id}`, `cus-${id}`);
    db.prepare(`INSERT INTO cron_schedules
      (account_id, project_id, schedule_id, version, definition, definition_hash, status)
      VALUES (?, 'p', 's', 1, '{}', 'hash', 'active')`).run(id);
    db.prepare(`INSERT INTO cron_leases
      (account_id, project_id, schedule_id, occurrence_at, version, expires_at)
      VALUES (?, 'p', 's', ?, 1, ?)`).run(id, NOW, FUTURE);
  }
  db.prepare('DELETE FROM accounts WHERE id = ?').run(first);
  for (const table of ['identities', 'sync_projects', 'sessions', 'refresh_tokens', 'auth_codes', 'team_members', 'cron_schedules', 'cron_leases']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(first).n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(second).n, 1);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE owner_account_id = ?').get(first).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE owner_account_id = ?').get(second).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_invites').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 2);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('timestamps persist integer UTC milliseconds without accepting date text', (t) => {
  const db = database(t);
  const id = account(db);
  db.prepare('UPDATE accounts SET created_at = ? WHERE id = ?').run(NOW, id);
  const row = db.prepare('SELECT created_at, typeof(created_at) AS kind FROM accounts WHERE id = ?').get(id);
  assert.equal(row.created_at, NOW);
  assert.equal(row.kind, 'integer');
  assert.throws(() => db.prepare('UPDATE accounts SET created_at = ? WHERE id = ?').run('2026-09-30', id), /cannot store TEXT value/);
});

test('new accounts default to user and do not start trial or bootstrap admins', (t) => {
  const db = database(t);
  for (const email of ['ordinary@example.test', 'admin@volarehost.com.br', 'retornoja@gmail.com']) {
    const id = account(db, email);
    const row = db.prepare(`SELECT role, trial_started_at, trial_expires_at,
      suspended_at, suspension_reason, last_seen_at FROM accounts WHERE id = ?`).get(id);
    assert.deepEqual(Object.values(row), ['user', null, null, null, null, null]);
  }
});

test('account roles accept only user and admin', (t) => {
  const db = database(t);
  const id = account(db);
  db.prepare("UPDATE accounts SET role = 'admin' WHERE id = ?").run(id);
  assert.equal(db.prepare('SELECT role FROM accounts WHERE id = ?').get(id).role, 'admin');
  assert.throws(() => db.prepare("UPDATE accounts SET role = 'owner' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE accounts SET role = NULL WHERE id = ?').run(id), /NOT NULL constraint failed/);
});

test('trial requires a complete positive interval and integer millisecond dates', (t) => {
  const db = database(t);
  const id = account(db);
  const update = db.prepare('UPDATE accounts SET trial_started_at = ?, trial_expires_at = ? WHERE id = ?');
  for (const [start, end] of [[null, FUTURE], [NOW, null], [NOW, NOW], [NOW, NOW - 1], [-1, FUTURE]]) {
    assert.throws(() => update.run(start, end, id), /CHECK constraint failed/);
  }
  assert.throws(() => update.run('2026-09-30', FUTURE, id), /cannot store TEXT value/);
  const trialEnd = NOW + 15 * 24 * 60 * 60 * 1000;
  update.run(NOW, trialEnd, id);
  const row = db.prepare('SELECT trial_started_at, trial_expires_at FROM accounts WHERE id = ?').get(id);
  assert.deepEqual(Object.values(row), [NOW, trialEnd]);
  update.run(null, null, id);
});

test('admin audit validates actions and JSON and survives actor and target deletion', (t) => {
  const db = database(t);
  const actor = account(db);
  const target = account(db);
  const auditId = randomUUID();
  const insert = db.prepare(`INSERT INTO admin_audit
    (id, actor_account_id, target_account_id, action, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(auditId, actor, target, 'suspend', '{"reason":"review"}', NOW);
  assert.throws(() => insert.run(randomUUID(), actor, target, 'delete', '{}', NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run(randomUUID(), actor, target, 'resume', 'not-json', NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run(randomUUID(), randomUUID(), target, 'extend_trial', '{}', NOW), /FOREIGN KEY constraint failed/);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(actor);
  assert.equal(db.prepare('SELECT actor_account_id FROM admin_audit WHERE id = ?').get(auditId).actor_account_id, null);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(target);
  const row = db.prepare('SELECT * FROM admin_audit WHERE id = ?').get(auditId);
  assert.equal(row.target_account_id, null);
  assert.equal(row.action, 'suspend');
  assert.equal(row.details, '{"reason":"review"}');
  assert.equal(row.created_at, NOW);
});
