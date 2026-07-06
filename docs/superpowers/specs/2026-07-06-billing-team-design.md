# Billing + Team — Design (Subsistema 2 do backend SaaS)

> Herda a arquitetura de [2026-07-06-saas-backend-arquitetura-design.md](./2026-07-06-saas-backend-arquitetura-design.md)
> e constrói sobre o Auth já entregue ([2026-07-06-auth-contas-design.md](./2026-07-06-auth-contas-design.md)).
> Stack: Express + Postgres/Drizzle no monorepo `server/`; tipos compartilhados em `shared/contract.ts`.

## Objetivo

Transformar assinatura Stripe em **licença JWT Ed25519** que o app já verifica
offline — destravar receita (Pro) e o plano **Team completo** (convites por
link, papéis owner/member, billing centralizado por assento).

## Decisões de escopo (aprovadas)

1. **Team completo junto** — teams, membros, convites e assentos entram agora.
2. **Convite por link/código** — sem serviço de email (Resend fica p/ fase 2).
3. **Sem trial no v1** — checkout direto pro pago; trial futuro via
   `trial_period_days` do Stripe sem mudar schema.
4. **Abordagem A — Stripe como fonte de verdade**: o banco guarda o espelho
   mínimo; o webhook, ao processar QUALQUER evento de assinatura, **busca o
   estado atual na API do Stripe** e aplica. Tolerância a ordem por construção
   (rev#5 da arquitetura). Idempotência por `event.id`.
5. **1 conta = 1 time no v1** — entitlement determinístico; multi-time é fase 2
   (remover um UNIQUE, sem quebrar schema).

## 1. Schema (novas tabelas Drizzle)

```
subscriptions
  id                    uuid PK
  ownerType             enum('account','team')
  accountId             uuid FK → accounts, NULL se ownerType='team'
  teamId                uuid FK → teams,    NULL se ownerType='account'
  stripeSubscriptionId  text UNIQUE NOT NULL
  stripeCustomerId      text NOT NULL
  plan                  plan ('pro'|'team')
  status                text  -- espelho Stripe: active|past_due|canceled|...
  seats                 int NOT NULL DEFAULT 1   -- quantity (1 p/ pro)
  currentPeriodEnd      timestamp                -- vira renewsAt da licença
  graceUntil            timestamp NULL           -- past_due → +7 dias
  createdAt / updatedAt

teams
  id              uuid PK
  name            text NOT NULL
  ownerAccountId  uuid FK → accounts NOT NULL
  createdAt

team_members
  teamId     uuid FK → teams    ON DELETE CASCADE
  accountId  uuid FK → accounts ON DELETE CASCADE
  role       enum('owner','member')
  joinedAt
  PK (teamId, accountId)
  UNIQUE (accountId)            -- 1 time por conta no v1

team_invites
  codeHash   text PK            -- sha256 do código, nunca em claro (padrão Auth)
  codePrefix text NOT NULL      -- 4 primeiros chars (ex.: "AB12") — só p/ o
                                -- owner LISTAR/REVOGAR; não dá acesso sozinho
  teamId     uuid FK → teams ON DELETE CASCADE
  createdBy  uuid FK → accounts
  maxUses    int NOT NULL DEFAULT 10
  usedCount  int NOT NULL DEFAULT 0
  expiresAt  timestamp NOT NULL -- 7 dias
  revokedAt  timestamp NULL

stripe_events
  eventId     text PK           -- idempotência: INSERT ... ON CONFLICT DO NOTHING
  type        text
  processedAt timestamp
  payload     jsonb             -- evento bruto p/ reprocesso/auditoria
```

- `accounts.plan` / `accounts.stripeCustomerId` (do Auth) continuam; `plan`
  vira **cache** do entitlement pessoal — a verdade é `subscriptions`.
- Consumo de convite e assentos usam os padrões atômicos do Auth
  (`UPDATE ... WHERE ... RETURNING`) — sem TOCTOU.
- DDL de teste em `CREATE_TABLES_SQL` (pglite) + migrations drizzle-kit reais,
  como no Auth.

## 2. Fluxos

### Checkout (app autenticado — sem login não há compra)

```
app "Assinar Pro" / "Criar time (N assentos)"
  → POST /v1/billing/checkout {plan:'pro'} | {plan:'team', seats:N, teamName}
    (Bearer)
  → guardas: plan 'team' com conta já em algum time → 409 (1 time por conta)
             plan 'pro' com assinatura pessoal ativa → 409 "use o portal"
  → backend: acha/cria stripeCustomer da conta
             team: cria team + owner AGORA (pendente até pagar)
             cria Checkout Session (mode=subscription, quantity=seats,
               metadata: {accountId, teamId?, plan})
  → responde {url} → app abre o browser nessa URL
  → pagou → redirect p/ https://nexuside.app/billing/success (informativa)
```

O `/pricing` da web manda baixar o app (checkout web sem login: fora do v1).

### Webhook — o coração

```
POST /v1/billing/webhook   (raw body + assinatura Stripe, SEM Bearer)
  1. stripe.webhooks.constructEvent → assinatura inválida = 400
  2. INSERT stripe_events ON CONFLICT DO NOTHING → duplicado = 200 e sai
  3. eventos: checkout.session.completed, customer.subscription.created/
     updated/deleted, invoice.payment_failed / invoice.paid
  4. p/ qualquer um: subscriptionId → BUSCA estado atual na API do Stripe →
     upsert em subscriptions (status, seats, currentPeriodEnd) → recalcula
     graceUntil (past_due → +7d; active → NULL) → atualiza accounts.plan
     (cache) se assinatura pessoal
  5. erro de processamento → 500 (retry do Stripe; evento bruto já gravado)
```

### Portal

`POST /v1/billing/portal` (Bearer) → Billing Portal Session → `{url}` → app
abre. Cartão, assentos (quantity) e cancelamento acontecem lá; tudo volta via
webhook.

### Licença

```
GET /v1/license  (Bearer)
  entitlement = max( assinatura pessoal ativa/grace,
                     plano do time onde sou membro ativo )
  → assina JWT {plan, status, renewsAt=currentPeriodEnd, graceUntil, exp}
    exp: 30d (pessoal/free) | 7d (derivada de time — remoção pega rápido)
```

App: renova no boot/reconexão; após abrir checkout, **polling a cada 5s por
2min**. Página de sucesso não carrega segredo nenhum (mesma regra do Auth).

## 3. Times

### Convite

```
POST /v1/team/invites            (Bearer, só owner)
  → código legível "AB12-CD34" (6 bytes base32) → guarda sha256
  → {code, url: "https://nexuside.app/join/AB12-CD34", expiresAt}

POST /v1/team/join {code}        (Bearer, qualquer conta logada)
  → consumo ATÔMICO:
      UPDATE team_invites SET used_count = used_count + 1
      WHERE code_hash=? AND revoked_at IS NULL AND expires_at > now
        AND used_count < max_uses
      RETURNING team_id
  → guardas: já está num time → 409 | sem assento livre → 409
             assinatura do time não active/grace → 409
  → INSERT team_members (role 'member') → {teamId, name}
```

Página web `/join/<code>`: "abra o NexusIDE e cole o código" (deep link fase 2).

### Gestão

- `GET /v1/team` — nome, membros (nome/avatar/role), assentos usados/total,
  convites vivos (owner vê tudo; member vê membros e assentos).
- `DELETE /v1/team/invites/:codePrefix` — owner revoga.
- `DELETE /v1/team/members/:accountId` — owner remove (não a si mesmo);
  licença do removido morre na renovação (TTL 7d limita a janela offline).
- `POST /v1/team/leave` — membro sai (owner não pode — cancela/transfere).

### Guardas de integridade

- **Owner + LGPD**: `DELETE /v1/me` de owner com assinatura de time ativa →
  409 "cancele a assinatura primeiro". Sem ativa: cascade apaga time/membros
  (membros voltam a Free na renovação da licença).
- **Downgrade de assentos** (portal): webhook aplica `seats`; se membros >
  assentos, NÃO expulsa ninguém — bloqueia joins novos e `GET /v1/team`
  sinaliza "acima do limite" (owner resolve).
- **Cancelamento**: `canceled` → todos caem pra Free na renovação; time e
  membros ficam no banco (reativar = nova assinatura).

## 4. Encaixes no app (Electron)

- **`src/main/api-client.ts` (novo)**: `apiFetch(path, opts)` anexa Bearer do
  Keychain (`auth:session`); num 401 tenta UMA rotação via
  `POST /v1/auth/refresh` (guarda par novo, repete a chamada; falhou →
  "precisa logar"). Deps injetáveis.
- **`billing-ipc.ts`**: `checkout`/`portal` deixam de abrir `BILLING_BASE`
  direto → chamam o backend via apiFetch e abrem a `{url}` retornada.
- **Polling pós-checkout** + **renovação no boot** via `GET /v1/license` →
  `applyLicenseToken` + `BILLING_CHANNELS.changed`.
- **AccountSection**: bloco de time — member: "entrar com código"; owner:
  gerar convite, membros/assentos, remover membro.
- **`shared/contract.ts`**: `TeamInfo`, `TeamMemberInfo`, `InviteInfo`,
  shapes de request/response do checkout.

## 5. Erros

- Envelope `{ok, data?, error?}`; 401 = sessão morta (refresh → login);
  409 sempre acionável ("sem assento livre", "cancele a assinatura primeiro").
- Webhook: assinatura inválida 400; falha 500 (retry Stripe); evento bruto
  gravado antes de processar.
- Stripe fora do ar no checkout → `{ok:false}` amigável; nunca trava o app.
- Rotas novas com `asyncHandler` + `errorHandler` (padrão pós-review do Auth).

## 6. Testes (pglite + deps injetadas, padrão do Auth)

- **Webhook**: idempotência (`event.id` 2x → 1 efeito); ordem (evento velho
  após novo → estado correto, pois busca a API); `past_due` → graceUntil +7d;
  cancel → Free.
- **Assentos**: corrida do último assento (`Promise.all` → 1 entra, 1 409);
  downgrade não expulsa.
- **Licença**: matriz de entitlement (pessoal vs time; TTL 7d/30d; grace).
- **Convites**: maxUses, expiração, revogação, código nunca em claro.
- **App**: apiFetch (401→refresh→retry), billing-ipc com fetch fake, polling.
- **Stripe SDK** (`stripe` npm) sempre **injetado**; testes usam fake tipado.

## 7. Env novo (staging/prod separados)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`,
`STRIPE_PRICE_TEAM`, `PUBLIC_SITE_URL` (success/cancel/join URLs).

## Fora do escopo (fases futuras)

- Convite por email (Resend), multi-time por conta, transferência de
  ownership, trial, checkout web sem login, deep link em `/join`.
- Páginas web com visual final (v1 = HTML server-rendered mínimo, §6 da
  arquitetura).
