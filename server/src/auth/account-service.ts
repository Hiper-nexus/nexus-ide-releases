import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, identities } from '../db/schema';
import type { OAuthProfile, Provider } from './oauth-providers';

/**
 * Find-or-create com MERGE seguro (anti account-takeover): só une identidades
 * quando AMBOS os lados têm o email verificado e coincidente. Nunca por email
 * não-verificado — nesse caso cria conta isolada.
 */

async function insertIdentity(
  db: Db,
  accountId: string,
  p: OAuthProfile,
): Promise<void> {
  await db.insert(identities).values({
    accountId,
    provider: p.provider,
    providerUserId: p.providerUserId,
    email: p.email,
    emailVerified: p.emailVerified,
  });
}

export async function findOrCreateAccount(
  db: Db,
  p: OAuthProfile,
): Promise<{ accountId: string; merged: boolean }> {
  // 1. identity já existe → usa a conta dela
  const existing = await db
    .select()
    .from(identities)
    .where(
      and(
        eq(identities.provider, p.provider as Provider),
        eq(identities.providerUserId, p.providerUserId),
      ),
    )
    .limit(1);
  if (existing[0]) return { accountId: existing[0].accountId, merged: false };

  // 2. merge por email — SÓ com email verificado dos dois lados
  if (p.email && p.emailVerified) {
    const byEmail = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, p.email))
      .limit(1);
    const acc = byEmail[0];
    if (acc) {
      // a conta existente precisa ter chegado por um email verificado:
      // exigimos que ELA tenha ao menos uma identity com email verificado.
      const verified = await db
        .select()
        .from(identities)
        .where(
          and(
            eq(identities.accountId, acc.id),
            eq(identities.emailVerified, true),
          ),
        )
        .limit(1);
      if (verified[0]) {
        await insertIdentity(db, acc.id, p);
        return { accountId: acc.id, merged: true };
      }
    }
  }

  // 3. cria conta nova + identity. Email único: se colidir com conta
  // não-verificada, usa um email desambiguado para não violar a constraint.
  const emailForAccount =
    p.email && p.emailVerified ? p.email : `${p.provider}:${p.providerUserId}`;
  const [created] = await db
    .insert(accounts)
    .values({ email: emailForAccount, name: p.name, avatarUrl: p.avatar })
    .returning({ id: accounts.id });
  await insertIdentity(db, created.id, p);
  return { accountId: created.id, merged: false };
}

export async function linkIdentity(
  db: Db,
  accountId: string,
  p: OAuthProfile,
): Promise<void> {
  await insertIdentity(db, accountId, p);
}
