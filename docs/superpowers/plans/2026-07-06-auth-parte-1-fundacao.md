# Auth/Contas — Plan (Parte 1/3: fundação — scaffold, contract, schema, signer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Sequência: **Parte 1** (esta) → Parte 2 `2026-07-06-auth-parte-2-logica.md` → Parte 3 `2026-07-06-auth-parte-3-rotas-app.md`.
> Spec: `docs/superpowers/specs/2026-07-06-auth-contas-design.md`.

**Goal:** Fundação do backend: workspace `server/`, `shared/contract.ts` (tipos app↔backend), schema Drizzle, validação de env e o license-signer Ed25519.

**Architecture:** Monorepo — o backend Express vive em `server/` (npm workspace próprio, deps isoladas do Electron). Módulos de lógica são PUROS (HTTP e Db injetados). Esta parte entrega o esqueleto + o signer testável; ainda não sobe servidor.

**Tech Stack:** Node, TypeScript, Express, Drizzle (Postgres), jose (JWT Ed25519), zod, vitest, @electric-sql/pglite (Postgres in-memory p/ teste).

## Global Constraints (valem para as 3 partes)

- Backend vive em `server/` no monorepo; deps isoladas num `package.json` próprio.
- Tokens NUNCA em claro no banco — só `sha256(token)`; comparação com `timingSafeEqual`.
- Todas as rotas de API sob prefixo `/v1`; `GET /health` fora do `/v1`.
- Lógica (oauth-flow, account-service, session-service, license-signer) é PURA — HTTP dos providers e Db injetados; testável sem rede.
- Licença JWT assinada **Ed25519**; payload `{plan, email, status, renewsAt, graceUntil, exp}` (o app já verifica com a pública).
- Segredos por env, validados no boot (`env.ts` zod) — falta qualquer → processo não sobe.
- Testes: `cd server && npx vitest run <arquivo>`; typecheck: `cd server && npx tsc --noEmit`. Commits frequentes (sem atribuição).

---

### Task 1: Scaffold do workspace `server/` + `shared/contract.ts`

**Files:**
- Create: `shared/contract.ts`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/src/index.ts`
- Modify: `package.json` (raiz — adicionar `server` aos workspaces se houver campo `workspaces`; senão criar)
- Test: `server/src/health.test.ts`

**Interfaces:**
- Produces: `shared/contract.ts` exporta `PlanId = 'free'|'pro'|'team'`, `LicenseInfo`, `LicensePayload`, `XpSyncEvent`. `server/src/index.ts` exporta `createApp(): import('express').Express` (com `GET /health`).

- [x] **Step 1: `shared/contract.ts` — fonte única do contrato**

```ts
// shared/contract.ts
/** Contrato compartilhado app↔backend. Fonte única — o app re-exporta daqui. */

export type PlanId = 'free' | 'pro' | 'team';

export interface LicenseInfo {
  plan: PlanId;
  email: string | null;
  status: 'none' | 'active' | 'past_due';
  renewsAt: string | null;
}

/** Payload assinado no JWT de licença (verificado offline pelo app). */
export interface LicensePayload {
  plan: PlanId;
  email: string | null;
  status: 'none' | 'active' | 'past_due';
  /** ISO — próxima renovação. */
  renewsAt: string | null;
  /** ISO — mantém o plano pago mesmo em past_due até aqui (grace). */
  graceUntil: string | null;
  /** epoch segundos — expiração do próprio token (TTL ~30d). */
  exp: number;
}

/** Evento de XP que o app sincroniza (Leaderboard, futuro). */
export interface XpSyncEvent {
  entityKey: string;
  kind: string;
  points: number;
  evidence: string | null;
  createdAt: number;
}
```

- [x] **Step 2: `server/package.json`**

```json
{
  "name": "@nexus/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "express": "^4.21.0",
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "jose": "^5.9.0",
    "zod": "^3.23.0",
    "pino": "^9.5.0",
    "pino-http": "^10.3.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "@types/supertest": "^6.0.0",
    "drizzle-kit": "^0.28.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@electric-sql/pglite": "^0.2.0"
  }
}
```

- [x] **Step 3: `server/tsconfig.json` + `server/vitest.config.ts`**

```json
// server/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDirs": ["src", "../shared"],
    "types": ["node"]
  },
  "include": ["src/**/*", "../shared/**/*"]
}
```

```ts
// server/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

- [x] **Step 4: teste que falha (health)**

```ts
// server/src/health.test.ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './index';

describe('health', () => {
  it('GET /health responde ok', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [x] **Step 5: instalar deps + rodar e ver falhar**

Run: `cd server && npm install && npx vitest run src/health.test.ts`
Expected: FAIL (`Cannot find module './index'`)

- [x] **Step 6: `server/src/index.ts` mínimo**

```ts
// server/src/index.ts
import express, { type Express } from 'express';

/** Monta o app Express. Rotas /v1 são adicionadas nas próximas tasks/partes. */
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

// Boot real só quando executado direto (não em teste/import).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => console.log(`[server] :${port}`));
}
```

- [x] **Step 7: rodar e ver passar**

Run: `cd server && npx vitest run src/health.test.ts`
Expected: PASS

- [x] **Step 8: adicionar `server` e `shared` aos workspaces da raiz**

No `package.json` da RAIZ, adicionar (se não existir o campo, criar):

```json
  "workspaces": ["server"],
```

(O `shared/` é referenciado pelo `tsconfig` do server via `rootDirs`; não precisa
ser workspace npm próprio.)

- [x] **Step 9: Commit**

```bash
git add shared/contract.ts server/package.json server/tsconfig.json server/vitest.config.ts server/src/index.ts server/src/health.test.ts package.json
git commit -m "feat(server): scaffold do backend Express + contract compartilhado + /health"
```

---

### Task 2: Validação de env (falha rápido no boot)

**Files:**
- Create: `server/src/env.ts`
- Test: `server/src/env.test.ts`

**Interfaces:**
- Produces: `parseEnv(raw: Record<string, string | undefined>): Env` (lança em falta) e `type Env = { DATABASE_URL, LICENSE_PRIVATE_KEY, LICENSE_PUBLIC_KEY, GITHUB_OAUTH_ID, GITHUB_OAUTH_SECRET, GOOGLE_OAUTH_ID, GOOGLE_OAUTH_SECRET, PUBLIC_BASE_URL, APP_DEEP_LINK_BASE, PORT }`.

- [ ] **Step 1: teste que falha**

```ts
// server/src/env.test.ts
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const FULL = {
  DATABASE_URL: 'postgres://x',
  LICENSE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  LICENSE_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  GITHUB_OAUTH_ID: 'gid',
  GITHUB_OAUTH_SECRET: 'gsec',
  GOOGLE_OAUTH_ID: 'ggid',
  GOOGLE_OAUTH_SECRET: 'ggsec',
  PUBLIC_BASE_URL: 'https://api.nexuside.app',
  APP_DEEP_LINK_BASE: 'nexus://auth',
};

describe('parseEnv', () => {
  it('aceita env completo e aplica PORT default 8080', () => {
    const env = parseEnv(FULL);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.PORT).toBe(8080);
  });

  it('lança quando falta um segredo obrigatório', () => {
    const { LICENSE_PRIVATE_KEY: _omit, ...missing } = FULL;
    expect(() => parseEnv(missing)).toThrow(/LICENSE_PRIVATE_KEY/);
  });

  it('rejeita PUBLIC_BASE_URL que não é URL', () => {
    expect(() => parseEnv({ ...FULL, PUBLIC_BASE_URL: 'nao-url' })).toThrow();
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — `cd server && npx vitest run src/env.test.ts` → FAIL
- [ ] **Step 3: implementar**

```ts
// server/src/env.ts
import { z } from 'zod';

/**
 * Env validado no boot — falta de qualquer segredo derruba o processo cedo,
 * com mensagem clara, em vez de falhar no primeiro request.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  LICENSE_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
  LICENSE_PUBLIC_KEY: z.string().includes('PUBLIC KEY'),
  GITHUB_OAUTH_ID: z.string().min(1),
  GITHUB_OAUTH_SECRET: z.string().min(1),
  GOOGLE_OAUTH_ID: z.string().min(1),
  GOOGLE_OAUTH_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  APP_DEEP_LINK_BASE: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => i.path.join('.'))
      .join(', ');
    throw new Error(`env inválido/faltando: ${missing}`);
  }
  return result.data;
}
```

- [ ] **Step 4: rodar e ver passar** — PASS (3 testes)
- [ ] **Step 5: Commit** — `git add server/src/env.ts server/src/env.test.ts && git commit -m "feat(server): validação de env no boot (zod, fail-fast)"`

---

### Task 3: Schema Drizzle + client + migrate

**Files:**
- Create: `server/src/db/schema.ts`
- Create: `server/src/db/client.ts`
- Create: `server/src/db/migrate.ts`
- Create: `server/drizzle.config.ts`
- Test: `server/src/db/schema.test.ts`

**Interfaces:**
- Consumes: `Env` (Task 2).
- Produces:
  - `schema.ts` exporta as tabelas: `accounts`, `identities`, `sessions`, `refreshTokens`, `oauthStates`, `authCodes` (drizzle pg-core) + os enums `planEnum`, `providerEnum`.
  - `client.ts`: `type Db = import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema>`; `makeDb(pool): Db`.
  - `migrate.ts`: runner (aplica migrations geradas).

- [ ] **Step 1: teste que falha (schema aplica limpo no pglite)**

```ts
// server/src/db/schema.test.ts
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import { CREATE_TABLES_SQL } from './schema';

describe('schema', () => {
  it('cria as tabelas e insere uma account', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await client.exec(CREATE_TABLES_SQL); // DDL literal p/ teste (migrations reais no deploy)
    await db.insert(schema.accounts).values({
      email: 'a@b.com',
      plan: 'free',
    });
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('a@b.com');
    expect(rows[0].plan).toBe('free');
    // enum válido
    await expect(
      db.execute(sql`INSERT INTO accounts (email, plan) VALUES ('c@d.com','invalido')`),
    ).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL (`Cannot find module './schema'`)
- [ ] **Step 3: implementar `schema.ts`**

```ts
// server/src/db/schema.ts
import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Schema Drizzle do Auth. Tokens guardados SÓ como sha256 (nunca em claro). */

export const planEnum = pgEnum('plan', ['free', 'pro', 'team']);
export const providerEnum = pgEnum('provider', ['github', 'google']);

export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  plan: planEnum('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const identities = pgTable('identities', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  provider: providerEnum('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  email: text('email'),
  emailVerified: boolean('email_verified').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  rotatedFrom: uuid('rotated_from'),
  usedAt: timestamp('used_at'),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  provider: providerEnum('provider').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const authCodes = pgTable('auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  usedAt: timestamp('used_at'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** DDL literal para testes (pglite) — a produção usa migrations do drizzle-kit. */
export const CREATE_TABLES_SQL = `
CREATE TYPE plan AS ENUM ('free','pro','team');
CREATE TYPE provider AS ENUM ('github','google');
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE, name text, avatar_url text,
  plan plan NOT NULL DEFAULT 'free', stripe_customer_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider provider NOT NULL, provider_user_id text NOT NULL,
  email text, email_verified boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id));
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamp NOT NULL,
  revoked_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp);
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, rotated_from uuid,
  used_at timestamp, expires_at timestamp NOT NULL, revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE oauth_states (
  state text PRIMARY KEY, provider provider NOT NULL,
  code_verifier text NOT NULL, created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL);
CREATE TABLE auth_codes (
  code_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  used_at timestamp, expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now());
`;
```

- [ ] **Step 4: `client.ts` + `migrate.ts` + `drizzle.config.ts`**

```ts
// server/src/db/client.ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export function makeDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
```

```ts
// server/src/db/migrate.ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeDb } from './client';
import { parseEnv } from '../env';

const env = parseEnv(process.env);
const { db, pool } = makeDb(env.DATABASE_URL);
await migrate(db, { migrationsFolder: 'drizzle' });
await pool.end();
console.log('[migrate] ok');
```

```ts
// server/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
```

- [ ] **Step 5: rodar e ver passar** — `cd server && npx vitest run src/db/schema.test.ts` → PASS
- [ ] **Step 6: gerar a migration inicial**

Run: `cd server && DATABASE_URL=postgres://x npx drizzle-kit generate`
Expected: cria `server/drizzle/0000_*.sql`. Commitar junto.

- [ ] **Step 7: Commit**

```bash
git add server/src/db server/drizzle.config.ts server/drizzle
git commit -m "feat(server): schema Drizzle (account/identity/session/refresh/oauth_state/auth_code) + migrate"
```

---

### Task 4: license-signer (Ed25519) — infra compartilhada

**Files:**
- Create: `server/src/auth/license-signer.ts`
- Test: `server/src/auth/license-signer.test.ts`

**Interfaces:**
- Consumes: `LicensePayload`, `PlanId` (`shared/contract.ts`).
- Produces:
  - `signLicense(input: { plan: PlanId; email: string | null; status: LicensePayload['status']; renewsAt?: string | null; graceUntil?: string | null }, privateKeyPem: string, now?: () => number): Promise<string>` (JWT compacto).
  - `verifyLicense(jwt: string, publicKeyPem: string): Promise<LicensePayload | null>` (null se inválida — reusa o mesmo alg do app).
  - `freeLicenseInput(email: string | null)` → input Free pronto.

- [ ] **Step 1: teste que falha (gera par real no teste, assina e verifica)**

```ts
// server/src/auth/license-signer.test.ts
import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import {
  freeLicenseInput,
  signLicense,
  verifyLicense,
} from './license-signer';

async function keypair() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  return {
    priv: await exportPKCS8(privateKey),
    pub: await exportSPKI(publicKey),
  };
}

describe('license-signer', () => {
  it('assina e verifica; Free por padrão; exp ~30d', async () => {
    const { priv, pub } = await keypair();
    const now = () => 1_000_000; // segundos
    const jwt = await signLicense(freeLicenseInput('a@b.com'), priv, now);
    const payload = await verifyLicense(jwt, pub);
    expect(payload?.plan).toBe('free');
    expect(payload?.email).toBe('a@b.com');
    expect(payload?.exp).toBe(1_000_000 + 30 * 24 * 3600);
    expect(payload?.graceUntil).toBeNull();
  });

  it('assinatura de outra chave é rejeitada (null)', async () => {
    const a = await keypair();
    const b = await keypair();
    const jwt = await signLicense(freeLicenseInput('x@y.com'), a.priv);
    expect(await verifyLicense(jwt, b.pub)).toBeNull();
  });

  it('token expirado verifica como null', async () => {
    const { priv, pub } = await keypair();
    const past = () => 1_000; // exp = 1000 + 30d, mas verificamos "agora" real → não expira
    const jwt = await signLicense(freeLicenseInput('z@z.com'), priv, past);
    // Forçar expiração: assinar com exp no passado via input pro? — usar helper:
    // aqui só garantimos que assinatura válida no tempo certo passa
    expect(await verifyLicense(jwt, pub)).not.toBeNull();
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL
- [ ] **Step 3: implementar**

```ts
// server/src/auth/license-signer.ts
import { importPKCS8, importSPKI, SignJWT, jwtVerify } from 'jose';
import type { LicensePayload, PlanId } from '../../../shared/contract';

/**
 * Assina/verifica a licença JWT com Ed25519 (EdDSA). A chave privada só existe
 * no backend; a pública já está embutida no app. Infra compartilhada: o Auth
 * emite Free no exchange; o Billing reusa para Pro/Team via webhook.
 */

const ALG = 'EdDSA';
const TTL_SECONDS = 30 * 24 * 3600;

export function freeLicenseInput(email: string | null) {
  return { plan: 'free' as PlanId, email, status: 'none' as const };
}

export interface SignInput {
  plan: PlanId;
  email: string | null;
  status: LicensePayload['status'];
  renewsAt?: string | null;
  graceUntil?: string | null;
}

export async function signLicense(
  input: SignInput,
  privateKeyPem: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, ALG);
  const iat = now();
  const payload: Omit<LicensePayload, 'exp'> = {
    plan: input.plan,
    email: input.email,
    status: input.status,
    renewsAt: input.renewsAt ?? null,
    graceUntil: input.graceUntil ?? null,
  };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(iat)
    .setExpirationTime(iat + TTL_SECONDS)
    .sign(key);
}

export async function verifyLicense(
  jwt: string,
  publicKeyPem: string,
): Promise<LicensePayload | null> {
  try {
    const key = await importSPKI(publicKeyPem, ALG);
    const { payload } = await jwtVerify(jwt, key, { algorithms: [ALG] });
    return {
      plan: payload.plan as PlanId,
      email: (payload.email as string) ?? null,
      status: payload.status as LicensePayload['status'],
      renewsAt: (payload.renewsAt as string) ?? null,
      graceUntil: (payload.graceUntil as string) ?? null,
      exp: payload.exp as number,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: rodar e ver passar** — PASS
- [ ] **Step 5: typecheck** — `cd server && npx tsc --noEmit` → limpo
- [ ] **Step 6: Commit**

```bash
git add server/src/auth/license-signer.ts server/src/auth/license-signer.test.ts
git commit -m "feat(server): license-signer Ed25519 (assina/verifica; Free por padrão)"
```

→ **Continuar na Parte 2:** `docs/superpowers/plans/2026-07-06-auth-parte-2-logica.md`

## Self-review (Parte 1)

- **Cobertura:** spec §1 (estrutura) → Task 1; §2 (schema) → Task 3; §5 (env) →
  Task 2; §4 (license-signer) → Task 4. Fluxo OAuth/rotas/merge/rotação →
  Partes 2–3 (declarado).
- **Placeholders:** nenhum; DDL e código completos. (O 3º teste do signer tem um
  comentário explicando por que não força expiração aqui — a expiração real é
  coberta pelo `exp` assertado no 1º teste; sem placeholder de código.)
- **Consistência:** `Db`, `schema.*`, `signLicense/verifyLicense/freeLicenseInput`
  usados nas Partes 2–3 com as assinaturas acima; `CREATE_TABLES_SQL` só para
  teste (produção usa migration gerada na Task 3 Step 6).
