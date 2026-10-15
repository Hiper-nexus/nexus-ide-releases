import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { environment, seedAccount } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';
import { issueTokens, revokeAll, rotateRefresh, sessionFor, type Tokens } from '../src/sessions.js';

// 14/10 incident: a desktop app that lost the 200 of a rotation presented the old refresh again 30 s later,
// and the reuse detection signed every desktop app of the account out.
const GRACE_MS = 60_000;
const json = { 'content-type': 'application/json' };

async function setup(): Promise<{ db: SqliteD1; mac: Tokens; vm: Tokens }> {
  const db = new SqliteD1();
  await seedAccount(db, 'user');
  return { db, mac: await issueTokens(db, 'user', 'desktop'), vm: await issueTokens(db, 'user', 'desktop') };
}

async function idOf(db: SqliteD1, raw: string): Promise<string> {
  const { hashToken } = await import('../src/crypto.js');
  const row = await db.prepare('SELECT id FROM refresh_tokens WHERE token_hash=?').bind(await hashToken(raw)).first<{ id: string }>();
  assert.ok(row, 'refresh token exists');
  return row.id;
}

async function events(db: SqliteD1): Promise<Array<{ kind: string; family_root: string; account_id: string }>> {
  return (await db.prepare('SELECT kind,family_root,account_id FROM auth_events ORDER BY created_at').all<{ kind: string; family_root: string; account_id: string }>()).results;
}

/** Runs `effect` once, right after the first statement matching `pattern` executes. */
function interleave(db: SqliteD1, pattern: RegExp, effect: () => Promise<unknown>): D1Database {
  let armed = true;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (property !== 'first' && property !== 'run' && property !== 'all') return Reflect.get(target, property);
      return async (...args: unknown[]) => {
        const result = await (Reflect.get(target, property) as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        if (armed) { armed = false; await effect(); }
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => armed && pattern.test(query) ? wrap(target.prepare(query)) : target.prepare(query);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Every statement matching `pattern` fails when it runs, as a D1 error would. */
function failing(db: SqliteD1, pattern: RegExp): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => target.prepare(pattern.test(query) ? 'UPDATE missing_table SET broken=1' : query);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function sessionStamp(db: SqliteD1, refresh: string): Promise<number | null | undefined> {
  return (await db.prepare('SELECT last_used_at AS at FROM sessions WHERE refresh_id=?').bind(await idOf(db, refresh)).first<{ at: number | null }>())?.at;
}

test('the first authenticated use stamps the session once; a failed stamp never fails the request', async () => {
  const { db, mac } = await setup();
  const now = Date.now();
  assert.equal(await sessionStamp(db, mac.refresh), null);

  assert.ok(await sessionFor(failing(db, /^UPDATE sessions SET last_used_at/), mac.session, 'desktop', now));
  assert.equal(await sessionStamp(db, mac.refresh), null);

  assert.ok(await sessionFor(db, mac.session, 'desktop', now + 1000));
  assert.equal(await sessionStamp(db, mac.refresh), now + 1000);
  assert.ok(await sessionFor(db, mac.session, 'desktop', now + 2000));
  assert.equal(await sessionStamp(db, mac.refresh), now + 1000, 'one write per session');
  db.close();
});

test('once the successor session was used, the old token inside the window is reuse: the family dies', async () => {
  const { db, mac, vm } = await setup();
  const root = await idOf(db, mac.refresh);
  const now = Date.now();
  const app = await rotateRefresh(db, mac.refresh, 'desktop', now);
  assert.ok(app);
  const me = await createApp().request('/v1/me', { headers: { Authorization: `Bearer ${app.tokens.session}` } }, environment(db));
  assert.equal(me.status, 200, 'the app uses its new session right away');

  // A copy of the rotated token comes back seconds later: the app did receive its pair.
  assert.equal(await rotateRefresh(db, mac.refresh, 'desktop', now + 5_000), null);

  assert.equal(await sessionFor(db, app.tokens.session, 'desktop'), null);
  assert.equal(await rotateRefresh(db, app.tokens.refresh, 'desktop', now + 6_000), null);
  assert.ok(await sessionFor(db, vm.session, 'desktop'), 'other devices stay signed in');
  assert.deepEqual(await events(db), [{ kind: 'refresh_reuse_family_revoked', family_root: root, account_id: 'user' }]);
  db.close();
});

test('a retry inside the grace window gets a new pair, kills the lost successor and spares other families', async () => {
  const { db, mac, vm } = await setup();
  const root = await idOf(db, mac.refresh);
  const now = Date.now();
  const lost = await rotateRefresh(db, mac.refresh, 'desktop', now);
  assert.ok(lost, 'first rotation succeeds; its response never reaches the app');

  const retried = await rotateRefresh(db, mac.refresh, 'desktop', now + 30_000);

  assert.ok(retried, 'the retry inside the window is answered with a pair');
  assert.equal(retried.accountId, 'user');
  assert.notEqual(retried.tokens.refresh, lost.tokens.refresh);
  assert.ok(await sessionFor(db, retried.tokens.session, 'desktop'));
  assert.equal(await sessionFor(db, lost.tokens.session, 'desktop'), null, 'the session issued with the lost successor dies');
  // The app never saw the lost successor, so it never presents it (see the superseded tests below).
  assert.ok(await sessionFor(db, vm.session, 'desktop'), 'other devices stay signed in');
  assert.ok(await sessionFor(db, mac.session, 'desktop'), 'the session issued at login stays valid until it expires');
  assert.ok(await rotateRefresh(db, vm.refresh, 'desktop', now + 32_000));
  assert.ok(await rotateRefresh(db, retried.tokens.refresh, 'desktop', now + 33_000), 'the new pair keeps renewing');
  assert.deepEqual(await events(db), [{ kind: 'refresh_reuse_grace', family_root: root, account_id: 'user' }]);
  db.close();
});

test('a thief that wins the window is caught when the app presents the successor it superseded', async () => {
  const { db, mac, vm } = await setup();
  const root = await idOf(db, mac.refresh);
  const now = Date.now();
  const app = await rotateRefresh(db, mac.refresh, 'desktop', now);
  assert.ok(app);
  // A copy of the rotated token arrives before the app touched its new pair: it looks like a lost response.
  const thief = await rotateRefresh(db, mac.refresh, 'desktop', now + 5_000);
  assert.ok(thief);
  assert.equal(await sessionFor(db, app.tokens.session, 'desktop'), null);

  // Its session revoked, the app refreshes with the successor it holds.
  assert.equal(await rotateRefresh(db, app.tokens.refresh, 'desktop', now + 6_000), null);

  assert.equal(await sessionFor(db, thief.tokens.session, 'desktop'), null, 'the thief loses the family');
  assert.equal(await rotateRefresh(db, thief.tokens.refresh, 'desktop', now + 7_000), null);
  assert.ok(await sessionFor(db, vm.session, 'desktop'), 'other devices stay signed in');
  assert.ok(await rotateRefresh(db, vm.refresh, 'desktop', now + 8_000));
  const caught = [{ kind: 'refresh_reuse_grace', family_root: root, account_id: 'user' }, { kind: 'refresh_reuse_family_revoked', family_root: root, account_id: 'user' }];
  assert.deepEqual(await events(db), caught);
  // Presented again, the successor finds a dead family and records nothing more.
  assert.equal(await rotateRefresh(db, app.tokens.refresh, 'desktop', now + 9_000), null);
  assert.deepEqual(await events(db), caught);
  db.close();
});

test('a retry that loses the race with a logout revokes and records nothing', async () => {
  const { db, mac } = await setup();
  const now = Date.now();
  assert.ok(await rotateRefresh(db, mac.refresh, 'desktop', now));
  const racing = interleave(db, /^SELECT \* FROM refresh_tokens WHERE token_hash/, () => revokeAll(db, 'user', now + 500));

  assert.equal(await rotateRefresh(racing, mac.refresh, 'desktop', now + 1000), null);

  assert.equal((await db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL').first<{ n: number }>())?.n, 0);
  assert.deepEqual(await events(db), []);
  db.close();
});

test('a superseded successor is inert after a logout, once expired, or when its family is already dead', async () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  {
    const { db, mac } = await setup();
    const lost = await rotateRefresh(db, mac.refresh, 'desktop', now);
    assert.ok(lost && await rotateRefresh(db, mac.refresh, 'desktop', now + 1000));
    await revokeAll(db, 'user', now + 2000);
    const fresh = await issueTokens(db, 'user', 'desktop', now + 3000);
    assert.equal(await rotateRefresh(db, lost.tokens.refresh, 'desktop', now + 4000), null);
    assert.ok(await sessionFor(db, fresh.session, 'desktop'), 'the login after the logout survives');
    assert.ok(await rotateRefresh(db, fresh.refresh, 'desktop', now + 5000));
    assert.deepEqual((await events(db)).map(event => event.kind), ['refresh_reuse_grace']);
    db.close();
  }
  {
    // Superseded a month ago; the family kept renewing and is alive today.
    const { db } = await setup();
    const old = await issueTokens(db, 'user', 'desktop', now - 31 * day);
    const lost = await rotateRefresh(db, old.refresh, 'desktop', now - 31 * day + 1000);
    const retried = await rotateRefresh(db, old.refresh, 'desktop', now - 31 * day + 2000);
    assert.ok(lost && retried);
    const current = await rotateRefresh(db, retried.tokens.refresh, 'desktop', now - 2 * day);
    assert.ok(current);
    assert.equal(await rotateRefresh(db, lost.tokens.refresh, 'desktop', now), null);
    assert.ok(await rotateRefresh(db, current.tokens.refresh, 'desktop', now + 1000), 'the family keeps renewing');
    assert.deepEqual((await events(db)).map(event => event.kind), ['refresh_reuse_grace']);
    db.close();
  }
});

test('concurrent retries of one lost rotation leave exactly one live pair', async () => {
  const { db, mac } = await setup();
  const parent = await idOf(db, mac.refresh);
  const now = Date.now();
  assert.ok(await rotateRefresh(db, mac.refresh, 'desktop', now));
  const live = async () => ({
    refresh: (await db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE rotated_from=? AND revoked_at IS NULL').bind(parent).first<{ n: number }>())?.n,
    session: (await db.prepare('SELECT count(*) AS n FROM sessions s JOIN refresh_tokens r ON r.id=s.refresh_id WHERE r.rotated_from=? AND s.revoked_at IS NULL').bind(parent).first<{ n: number }>())?.n,
  });

  const results = await Promise.all([1, 2, 3].map(step => rotateRefresh(db, mac.refresh, 'desktop', now + step * 1000)));
  assert.ok(results.some(Boolean));
  assert.deepEqual(await live(), { refresh: 1, session: 1 });

  // A second retry that runs whole between the first one's lookup and its write.
  let inner: Awaited<ReturnType<typeof rotateRefresh>> = null;
  const racing = interleave(db, /^SELECT \* FROM refresh_tokens WHERE token_hash/, async () => { inner = await rotateRefresh(db, mac.refresh, 'desktop', now + 5000); });
  const outer = await rotateRefresh(racing, mac.refresh, 'desktop', now + 5000);
  assert.ok(inner && outer);
  assert.deepEqual(await live(), { refresh: 1, session: 1 });
  const winner = [outer, inner].filter(pair => pair !== null);
  const alive = await Promise.all(winner.map(async pair => Boolean(await sessionFor(db, pair!.tokens.session, 'desktop'))));
  assert.deepEqual(alive.filter(Boolean).length, 1);
  db.close();
});

test('reuse past the window revokes only that family; the other device keeps its session', async () => {
  const { db, mac, vm } = await setup();
  const root = await idOf(db, mac.refresh);
  const now = Date.now();
  const first = await rotateRefresh(db, mac.refresh, 'desktop', now);
  assert.ok(first);
  const second = await rotateRefresh(db, first.tokens.refresh, 'desktop', now + 1000);
  assert.ok(second);

  // The middle of the chain comes back long after it was rotated.
  assert.equal(await rotateRefresh(db, first.tokens.refresh, 'desktop', now + 1000 + GRACE_MS), null);

  for (const session of [mac.session, first.tokens.session, second.tokens.session]) {
    assert.equal(await sessionFor(db, session, 'desktop'), null, 'every session of the family dies');
  }
  assert.equal(await rotateRefresh(db, second.tokens.refresh, 'desktop', now + 2000 + GRACE_MS), null);
  assert.ok(await sessionFor(db, vm.session, 'desktop'), 'the other family survives');
  assert.ok(await rotateRefresh(db, vm.refresh, 'desktop', now + 3000 + GRACE_MS), 'and keeps renewing');
  assert.deepEqual(await events(db), [{ kind: 'refresh_reuse_family_revoked', family_root: root, account_id: 'user' }]);
  db.close();
});

test('reuse inside the window after the successor was used is real reuse of that family only', async () => {
  const { db, mac, vm } = await setup();
  const now = Date.now();
  const first = await rotateRefresh(db, mac.refresh, 'desktop', now);
  assert.ok(first);
  const second = await rotateRefresh(db, first.tokens.refresh, 'desktop', now + 1000);
  assert.ok(second, 'the client did receive the first pair and used it');

  assert.equal(await rotateRefresh(db, mac.refresh, 'desktop', now + 2000), null);

  assert.equal(await sessionFor(db, second.tokens.session, 'desktop'), null);
  assert.equal(await rotateRefresh(db, second.tokens.refresh, 'desktop', now + 3000), null);
  assert.ok(await sessionFor(db, vm.session, 'desktop'));
  assert.deepEqual((await events(db)).map(event => event.kind), ['refresh_reuse_family_revoked']);
  db.close();
});

test('a revoked or expired refresh token revokes nothing', async () => {
  const { db, mac } = await setup();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  await revokeAll(db, 'user', now, 'desktop');
  // Rotated a month ago: used, never revoked, but expired since.
  const old = await issueTokens(db, 'user', 'desktop', now - 31 * day);
  assert.ok(await rotateRefresh(db, old.refresh, 'desktop', now - 31 * day + 1000));
  const fresh = await issueTokens(db, 'user', 'desktop', now);

  for (const dead of [mac.refresh, old.refresh]) {
    assert.equal(await rotateRefresh(db, dead, 'desktop', now + 1000), null);
  }

  assert.ok(await sessionFor(db, fresh.session, 'desktop'), 'the login made after the revocation survives');
  assert.ok(await rotateRefresh(db, fresh.refresh, 'desktop', now + 2000));
  assert.deepEqual(await events(db), []);
  db.close();
});

test('logout still revokes every session and refresh token of the account', async () => {
  const { db, mac, vm } = await setup();
  const web = await issueTokens(db, 'user', 'web');
  const response = await createApp().request('/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${mac.session}` } }, environment(db));
  assert.equal(response.status, 200);
  for (const [session, channel] of [[mac.session, 'desktop'], [vm.session, 'desktop'], [web.session, 'web']] as const) {
    assert.equal(await sessionFor(db, session, channel), null);
  }
  assert.equal(await rotateRefresh(db, vm.refresh, 'desktop'), null);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL').first<{ n: number }>())?.n, 0);
  db.close();
});

test('/auth/refresh answers with the rotated pair while the license is still being signed', async (t) => {
  const { db, mac } = await setup();
  let reached!: () => void;
  const slow = new Promise<void>(resolve => { reached = resolve; });
  // The license read stalls forever right after it starts.
  const stalled = interleave(db, /^SELECT \* FROM accounts WHERE id=\?/, async () => { reached(); await new Promise(() => {}); });
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const pending = createApp().request('/v1/auth/refresh', { method: 'POST', headers: json, body: JSON.stringify({ refresh: mac.refresh }) }, environment(stalled as SqliteD1));
  await slow;
  mock.timers.tick(2_000);
  const response = await pending;

  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; data: { session: string; refresh: string; licenca?: string } };
  assert.equal(body.ok, true);
  assert.equal(body.data.licenca, undefined, 'the app fetches /v1/license itself');
  assert.ok(await sessionFor(db, body.data.session, 'desktop'));
  assert.ok(await rotateRefresh(db, body.data.refresh, 'desktop'));
  db.close();
});
