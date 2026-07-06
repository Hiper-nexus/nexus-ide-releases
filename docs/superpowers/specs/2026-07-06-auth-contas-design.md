# Backend SaaS — Subsistema 1: Auth / Contas (design)

Data: 2026-07-06 · Status: design aprovado, aguardando plano de implementação.

Primeiro subsistema do backend SaaS. Herda a arquitetura compartilhada
(`docs/superpowers/specs/2026-07-06-saas-backend-arquitetura-design.md`):
Express + Postgres/Drizzle no monorepo, OAuth Google+GitHub, code-exchange via
`nexus://`, dois tokens (session opaco + licença JWT Ed25519), `/v1` versionado.

**Escopo:** o subsistema Auth **completo** — OAuth dos dois providers, o loop de
login ponta a ponta (browser → code → exchange → tokens no Keychain), rotação de
refresh, merge seguro, vinculação, logout, `/me`, `DELETE /me` (LGPD),
rate-limit, o signer de licença (Free) e o encaixe no app (deep-link `auth`).
Billing/Assets/Leaderboard são subsistemas separados.

---

## 1. Estrutura de arquivos (monorepo)

```
nexus-ide/
  src/                    (app Electron — já existe)
  shared/                 ← NOVO: contrato app↔backend (fonte única)
    contract.ts             LicenseInfo, PlanId, XpSyncEvent
  server/                 ← NOVO: backend Express (npm workspace próprio)
    src/
      index.ts              boot Express + /health + monta /v1
      env.ts                validação zod das env vars (falha rápido no boot)
      db/
        schema.ts           schema Drizzle (§2)
        client.ts           conexão Postgres + runner de migrations
      auth/
        oauth-providers.ts  config GitHub/Google (URLs, scopes, parse de perfil) — PURO
        oauth-flow.ts       startAuth + exchangeCode (HTTP injetado) — testável
        account-service.ts  findOrCreate + MERGE seguro — PURO sobre Db
        session-service.ts  issue/rotate session+refresh, detecção de reuso — PURO
        license-signer.ts   assinar licença JWT Ed25519 (Free no exchange)
        auth-routes.ts      endpoints /v1/auth/* (Express fino)
      middleware/
        rate-limit.ts       por IP (espelha remote-bridge do app)
        require-auth.ts     Bearer → sessão
      web/                  páginas /return, /pricing (HTML mínimo)
    Dockerfile              builda só server/ + shared/
    drizzle.config.ts
    package.json            deps: Express, drizzle-orm, drizzle-kit, jose, zod, pino
                            devDeps: vitest, supertest, @electric-sql/pglite
    vitest.config.ts
```

**Princípio:** a lógica (oauth-flow, account-service, session-service,
license-signer) é **pura e testável** — HTTP dos providers e acesso ao banco são
**injetados**. As rotas Express são cascas finas que chamam os services.

**`shared/contract.ts`:** a fonte única dos tipos de contrato. O app
(`src/shared/billing-types.ts`) passa a **re-exportar** `LicenseInfo`/`PlanId`
de `shared/contract.ts` — zero duplicação, um tipo muda e os dois lados veem.

---

## 2. Schema Drizzle

```
account
  id                 uuid pk          email text unique NOT NULL (verificado canônico)
  name, avatar_url   text             plan enum('free','pro','team') default 'free'
  stripe_customer_id text null        created_at, updated_at

identity                              -- 1 conta pode ter github E google
  id uuid pk         account_id → account (cascade delete)
  provider enum('github','google')    provider_user_id text
  email text         email_verified boolean   -- do provider (regra de merge)
  unique(provider, provider_user_id)

session                               -- token opaco de API, curto
  id uuid pk         account_id → account (cascade)
  token_hash text unique              -- SÓ sha256, nunca o token cru
  expires_at, revoked_at null, created_at, last_used_at

refresh_token                         -- rotação com detecção de reuso
  id uuid pk         account_id → account (cascade)
  token_hash text unique              rotated_from uuid null   -- cadeia
  used_at null, expires_at, revoked_at null, created_at

oauth_state                           -- CSRF + PKCE, TTL ~10min
  state text pk      provider enum    code_verifier text (PKCE)
  created_at, expires_at

auth_code                             -- o CODE de uso único do nexus:// (TTL ~60s)
  code_hash text pk  account_id → account (cascade)
  used_at null, expires_at, created_at
```

**Decisões:**
- **Tokens nunca em claro** — só `sha256(token)`. Dump vazado ≠ contas
  comprometidas.
- **`DELETE /me` (LGPD)** = hard delete de `account` → cascade apaga
  identity/session/refresh/auth_code. (Eventos de XP sincronizados só existem no
  Leaderboard; exclusão deles é tratada lá.)
- **PKCE** no `oauth_state` — defesa extra mesmo com client secret.
- **`email` unique em `account`** é o eixo do merge.

---

## 3. Fluxo OAuth + endpoints

```
1. GET /v1/auth/:provider (github|google)
   → oauth-flow.startAuth(provider): state + PKCE verifier
   → grava em oauth_state (TTL 10min); redireciona pro provider (state + challenge)
   [rate-limit por IP]

2. GET /v1/auth/:provider/callback?code=…&state=…
   → valida state (existe? não expirou?) — senão 400
   → oauth-flow.exchangeCode(code, verifier) [HTTP INJETADO]
       → perfil normalizado {provider, providerUserId, email, emailVerified, name, avatar}
   → account-service.findOrCreate(perfil):  (matriz de merge — §4)
   → gera auth_code (uso único, TTL 60s), grava hash
   → redireciona pra  nexus://auth/<code>

3. POST /v1/auth/exchange {code}
   → valida auth_code (existe? não usado? não expirou?) → marca usado
   → session-service.issue(accountId): session (32B, TTL 15min) + refresh (32B, TTL 30d), só hashes
   → license-signer.sign(account): licença JWT Ed25519 (plano atual — Free numa conta nova)
   → responde { session, refresh, licenca }   [token só no corpo do POST HTTPS]
   [rate-limit por IP]

4. Uso normal:
   POST /v1/auth/refresh {refresh}   → rotação; reuso detectado → revoga cadeia, 401 (§4)
   POST /v1/auth/link {code}         → vincula 2º provider à conta logada (Bearer)
   POST /v1/auth/logout              → revoga session + refresh
   GET  /v1/me                       → perfil + plano (Bearer)
   DELETE /v1/me                     → hard delete + cascade (LGPD), confirmação forte
```

Envelope `{ok, data?, error?}`. Todas sob `/v1`. `GET /health` fora do `/v1`.

---

## 4. Regras críticas (o miolo dos testes)

### Matriz de merge (`account-service.findOrCreate`) — anti account-takeover
| Situação | Ação |
|---|---|
| `identity(provider, providerUserId)` já existe | usa a conta dela |
| não existe, mas email **verificado** casa com conta cujo email é verificado | **MERGE**: cria identity nova ligada à conta existente |
| não existe e nenhum email casa | cria account nova + identity |
| email **NÃO** verificado e não há identity | cria conta **isolada** — NUNCA merge por email não-verificado |

`POST /v1/auth/link` cobre o caso em que o usuário quer vincular manualmente um
provider cujo email não pôde dar merge automático (autenticado, confirmação
explícita).

### Rotação de refresh (`session-service`) — detecção de reuso
- Cada `refresh` usado → marca `used_at`, emite par novo (`rotated_from` = id
  anterior).
- `refresh` que chega **já com `used_at`** = token roubado sendo reusado →
  **revoga toda a cadeia** (todos os refresh/session da conta), responde 401. O
  usuário legítimo re-loga; o atacante fica sem nada.

### License signer (infra compartilhada)
Assina JWT Ed25519 (chave privada por env; pública já no app). No Auth, emite
sempre **Free** (plano da conta nova). Payload que o app já verifica:
`{plan, email, status, renewsAt, graceUntil, exp}`. Billing reusa o mesmo signer
para Pro/Team via webhook. O app sempre tem entitlement assinado, mesmo Free.

---

## 5. Segurança & operação

- **Rate limit por IP** em `/v1/auth/:provider`, `/callback`, `/exchange`,
  `/refresh` — brute-force de code/refresh. Padrão da `remote-bridge` do app
  (janela deslizante, teto por IP, backoff).
- **Tokens**: só hash no banco; comparação em tempo constante
  (`timingSafeEqual`). `state`/`code`/session/refresh gerados com
  `crypto.randomBytes(32)`.
- **Env validado no boot** (`env.ts` zod): `DATABASE_URL`, `LICENSE_PRIVATE_KEY`,
  `GITHUB_OAUTH_ID/SECRET`, `GOOGLE_OAUTH_ID/SECRET`, `SESSION_SIGNING_KEY`,
  `APP_DEEP_LINK_BASE` (nexus://auth), `PUBLIC_BASE_URL`. Falta qualquer uma →
  o processo não sobe.
- **CORS**: a API não é consumida por browser de terceiros (só o app via HTTP e
  a casca web própria) — CORS restrito à origem da casca web.
- **HTTPS** obrigatório em prod (o host termina TLS); cookies (se houver na casca
  web) `Secure`+`HttpOnly`+`SameSite`.

---

## 6. Encaixe no APP (mudanças mínimas)

- `deep-link.ts` ganha o caso `auth`: `parseDeepLink('nexus://auth/<code>')` →
  `{kind:'auth', code}`. Validação: code no conjunto seguro, tamanho limitado
  (mesmo rigor dos casos `license`/`open` que já existem).
- Um `auth-client.ts` (main): recebe o code → `POST /v1/auth/exchange` →
  guarda `session`/`refresh`/`licenca` no Keychain (`secrets-store`); agenda o
  refresh; aplica a licença (reusa `billing-ipc.applyLicenseToken`).
- UI: botão "Entrar com GitHub/Google" na `AccountSection` (já existe) que abre
  `shell.openExternal(<backend>/v1/auth/github|google)`.
- `NEXUS_LICENSE_PUBKEY` apontada para a pública real do backend.

*(Estes encaixes no app entram como tasks do plano — o app está no mesmo repo.)*

---

## 7. Testes

- **`oauth-providers`/`oauth-flow`**: parse de perfil GitHub vs Google
  (formatos diferentes de email/verified), HTTP injetado — sem rede.
- **`account-service`**: a matriz de merge inteira (4 linhas da tabela §4) +
  idempotência de identity.
- **`session-service`**: emissão, rotação feliz, e **detecção de reuso** (revoga
  cadeia).
- **`license-signer`**: assina e o payload verifica com a pública (reusa o
  verificador do app); Free por padrão; `exp`/`graceUntil` presentes.
- **Banco**: Postgres in-memory (pglite) ou Db fake; migrations aplicam limpo.
- **Rotas**: um smoke de integração do loop feliz (supertest) com providers
  mockados.

---

## 8. Fora de escopo (outros subsistemas)

- Billing/licença paga (webhook Stripe emitindo Pro/Team) — subsistema 2, reusa
  o `license-signer`.
- Modelo de **time** (convites/papéis) — subsistema Billing/Team.
- Update feed — subsistema Assets. Sync de XP — Leaderboard.

---

## 9. Racional

- **Loop completo com os 2 providers de uma vez**: o risco do Auth é a
  integração ponta a ponta (browser→code→exchange→Keychain); provar isso é o
  valor. Google e GitHub compartilham 90% do fluxo — só o parse de perfil difere.
- **Lógica pura + rotas finas**: mesmo padrão do app; a maior parte do Auth é
  unit-testável sem subir servidor.
- **Signer emitido já no Auth**: Free precisa de entitlement assinado consistente,
  e a infra de assinatura é compartilhada — Billing entra reusando, não
  reescrevendo.
- **Segurança por padrão**: PKCE, code-exchange, só-hash, rotação com detecção de
  reuso, rate-limit, LGPD — herdados da arquitetura rev.2.
