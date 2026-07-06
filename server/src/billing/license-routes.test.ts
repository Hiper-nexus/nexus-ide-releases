import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as schema from '../db/schema';
import { errorHandler } from '../middleware/errors';
import { setup } from './test-helpers';
import { buildLicenseRouter } from './license-routes';

describe('GET /v1/license', () => {
  it('reflete o entitlement e verifica com a chave publica', async () => {
    const { db, env, bearer, accountId } = await setup();
    const app = express();
    app.use(express.json());
    app.use('/v1', buildLicenseRouter({ db, env }));
    app.use(errorHandler);

    const r0 = await request(app).get('/v1/license').set('authorization', bearer);
    expect(r0.status).toBe(200);
    const { verifyLicense } = await import('../auth/license-signer');
    expect((await verifyLicense(r0.body.data.licenca, env.LICENSE_PUBLIC_KEY))!.plan).toBe('free');

    const [team] = await db.insert(schema.teams)
      .values({ name: 'S', ownerAccountId: accountId })
      .returning({ id: schema.teams.id });
    await db.insert(schema.teamMembers)
      .values({ teamId: team.id, accountId, role: 'owner' });
    await db.insert(schema.subscriptions).values({
      ownerType: 'team',
      teamId: team.id,
      stripeSubscriptionId: 's',
      stripeCustomerId: 'c',
      plan: 'team',
      status: 'active',
      seats: 3,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });

    const r1 = await request(app).get('/v1/license').set('authorization', bearer);
    expect((await verifyLicense(r1.body.data.licenca, env.LICENSE_PUBLIC_KEY))!.plan).toBe('team');
    expect((await request(app).get('/v1/license')).status).toBe(401);
  });
});
