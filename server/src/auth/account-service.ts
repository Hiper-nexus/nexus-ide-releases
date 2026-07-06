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

/**
 * drizzle-orm >= 0.38 envolve o erro do driver num DrizzleQueryError,
 * guardando o erro real do Postgres em `.cause` (code/message só existem
 * lá). Checamos os dois níveis para não perder a detecção de corrida.
 */
function isUniqueViolation(err: unknown): boolean {
  const layers = [err, (err as { cause?: unknown })?.cause];
  return layers.some((layer) => {
    const code = (layer as { code?: string })?.code;
    const msg = layer instanceof Error ? layer.message : String(layer ?? '');
    return code === '23505' || /duplicate key|unique constraint/i.test(msg);
  });
}

const MAX_RACE_RETRIES = 3;

export async function findOrCreateAccount(
  db: Db,
  p: OAuthProfile,
  attempt = 0,
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
  let verifiedEmailTaken = false;
  if (p.email && p.emailVerified) {
    const byEmail = await db
      .select()
      .from(accounts)
      .where(eq(accounts.email, p.email))
      .limit(1);
    const acc = byEmail[0];
    if (acc) {
      // Conta segurando o email mas NÃO-mesclável: o passo 3 precisa usar
      // email sintético, senão a UNIQUE(email) derruba o login (500/DoS).
      verifiedEmailTaken = true;
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
        try {
          await insertIdentity(db, acc.id, p);
        } catch (err) {
          // Corrida: outro request inseriu esta identity primeiro →
          // re-resolve do topo (o passo 1 encontra e reusa).
          if (isUniqueViolation(err) && attempt < MAX_RACE_RETRIES) {
            return findOrCreateAccount(db, p, attempt + 1);
          }
          throw err;
        }
        return { accountId: acc.id, merged: true };
      }
    }
  }

  // 3. cria conta nova + identity. Email único: se colidir com conta
  // não-mesclável (ou não for verificado), usa um email desambiguado
  // estável para não violar a constraint.
  const emailForAccount =
    p.email && p.emailVerified && !verifiedEmailTaken
      ? p.email
      : `${p.provider}:${p.providerUserId}`;
  try {
    // Transação: conta + identity nascem juntas. Sem isso, uma violação na
    // identity deixaria uma conta órfã que envenena merges futuros por email.
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({ email: emailForAccount, name: p.name, avatarUrl: p.avatar })
        .returning({ id: accounts.id });
      await insertIdentity(tx as unknown as Db, row.id, p);
      return row;
    });
    return { accountId: created.id, merged: false };
  } catch (err) {
    // Corrida de primeiro login duplo: o perdedor bate na UNIQUE (do email
    // da conta ou do subject da identity) e re-resolve do topo, achando a
    // conta do vencedor. Nunca 500, nunca duplicata.
    if (isUniqueViolation(err) && attempt < MAX_RACE_RETRIES) {
      return findOrCreateAccount(db, p, attempt + 1);
    }
    throw err;
  }
}

export async function linkIdentity(
  db: Db,
  accountId: string,
  p: OAuthProfile,
): Promise<void> {
  await insertIdentity(db, accountId, p);
}
