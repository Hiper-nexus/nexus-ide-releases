import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { accounts, CREATE_TABLES_SQL, cronLeases } from '../db/schema';
import * as schema from '../db/schema';
import {
  acquireCronLease,
  publishCronSchedule,
  renewCronLease,
} from './cron-service';

const PROJECT_ID = '31781d36-3f22-41b8-ad9d-8690c85d3343';
const SCHEDULE_ID = '2a21a665-d7fd-45d5-b81f-41f433c665ad';
const OCCURRENCE_AT = 1_800_000_000_000;
const NOW = 1_700_000_000_000;

function definition(name: string) {
  return {
    schemaVersion: 1 as const,
    name,
    schedule: '0 0 * * *',
    brief: 'Review the project against its acceptance criteria.',
    target: { kind: 'agent' as const, id: 'reviewer' },
    status: 'active' as const,
  };
}

async function setup() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema }) as unknown as Db;
  const [account] = await db
    .insert(accounts)
    .values({ email: `cron-race-${crypto.randomUUID()}@test.local` })
    .returning({ id: accounts.id });
  const first = await publishCronSchedule(
    { db, now: () => NOW },
    {
      accountId: account.id,
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      expectedVersion: 0,
      definition: definition('Version one'),
    },
  );
  if (!first.ok) throw new Error('test schedule was not created');
  return { accountId: account.id, client, db, first: first.schedule };
}

function pauseNextExecute(db: Db) {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let shouldPause = true;
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'execute') {
        return async (...args: Parameters<Db['execute']>) => {
          if (shouldPause) {
            shouldPause = false;
            enter();
            await resumed;
          }
          return target.execute(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, entered, resume };
}

async function publishSecondVersion(db: Db, accountId: string): Promise<void> {
  const result = await publishCronSchedule(
    { db, now: () => NOW + 1 },
    {
      accountId,
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      expectedVersion: 1,
      definition: definition('Version two'),
    },
  );
  expect(result.ok).toBe(true);
}

describe('cron lease definition authority', () => {
  it('does not acquire after the definition changes at the write barrier', async () => {
    const fixture = await setup();
    const barrier = pauseNextExecute(fixture.db);
    const acquiring = acquireCronLease(
      { db: barrier.db, now: () => NOW, makeToken: () => 'acquire-token' },
      fixture.accountId,
      {
        projectId: PROJECT_ID,
        scheduleId: SCHEDULE_ID,
        definitionVersion: 1,
        definitionHash: fixture.first.definitionHash,
        occurrenceAt: OCCURRENCE_AT,
        ttlMs: 90_000,
      },
    );

    await barrier.entered;
    await publishSecondVersion(fixture.db, fixture.accountId);
    barrier.resume();

    await expect(acquiring).resolves.toMatchObject({
      acquired: false,
      reason: 'definition-conflict',
      actualVersion: 2,
    });
    await expect(fixture.db.select().from(cronLeases)).resolves.toHaveLength(0);
    await fixture.client.close();
  });

  it('does not renew after the definition changes at the write barrier', async () => {
    const fixture = await setup();
    const leaseInput = {
      projectId: PROJECT_ID,
      scheduleId: SCHEDULE_ID,
      definitionVersion: 1,
      definitionHash: fixture.first.definitionHash,
      occurrenceAt: OCCURRENCE_AT,
      ttlMs: 90_000,
    };
    const acquired = await acquireCronLease(
      { db: fixture.db, now: () => NOW, makeToken: () => 'renew-token' },
      fixture.accountId,
      leaseInput,
    );
    if (!acquired.acquired) throw new Error('test lease was not acquired');
    const [before] = await fixture.db
      .select()
      .from(cronLeases)
      .where(eq(cronLeases.accountId, fixture.accountId));
    const barrier = pauseNextExecute(fixture.db);
    const renewing = renewCronLease(
      { db: barrier.db, now: () => NOW + 10_000 },
      fixture.accountId,
      { ...leaseInput, token: acquired.token },
    );

    await barrier.entered;
    await publishSecondVersion(fixture.db, fixture.accountId);
    barrier.resume();

    await expect(renewing).resolves.toMatchObject({
      acquired: false,
      reason: 'definition-conflict',
      actualVersion: 2,
    });
    const [after] = await fixture.db
      .select()
      .from(cronLeases)
      .where(eq(cronLeases.accountId, fixture.accountId));
    expect(after.version).toBe(before.version);
    expect(after.expiresAt).toEqual(before.expiresAt);
    await fixture.client.close();
  });
});
