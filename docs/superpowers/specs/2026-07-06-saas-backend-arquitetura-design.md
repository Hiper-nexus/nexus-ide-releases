# SaaS Backend NexusIDE — Arquitetura compartilhada (design)

Data: 2026-07-06 · Status: design aprovado, aguardando specs dos subsistemas.

Spec-guarda-chuva: a **fundação comum** que os quatro subsistemas do backend
herdam. Não é implementável sozinha — define stack, identidade, contrato e
deploy que Auth / Billing / Assets / Leaderboard reusam. Cada subsistema ganha
sua própria spec detalhada → plano → build.

O app NexusIDE é **local-first** e continua assim: o backend só liga as camadas
já desenhadas como *gated* (billing/licença, leaderboard de time, update feed).
Sem backend, o app funciona 100% offline no plano Free.

---

## 1. Subsistemas & ordem

Quatro subsistemas independentes, uma arquitetura só, implementados em
sequência:

1. **Auth / Contas** (fundação — pré-requisito dos outros): identidade, login,
   conta, time.
2. **Billing + Licença** (traz receita): Stripe → emitir a licença JWT que o app
   já verifica. Destrava Pro/Team.
3. **Assets** (update feed): o feed do auto-updater que o app já espera.
4. **Leaderboard** (gated, por último — mais complexo): sync de XP com
   revalidação por evidência, ranking de time.

Receita entra assim que 1+2 saem; leaderboard não bloqueia monetização.

---

## 2. Stack, banco & deploy

- **Runtime**: Node + **Express** num container (Dockerfile), rodando 24/7 —
  processo sempre quente (bom para o WebSocket futuro do leaderboard).
- **Host**: Fly.io / Railway / VPS. Deploy num `git push` (build do Docker no
  host). `GET /health` para health check.
- **Banco**: **Postgres gerenciado** (Fly PG / Neon / Railway). ORM + migrations
  em **Drizzle** (schema tipado em TS, migrations versionadas, rodadas no
  deploy) — casa com a filosofia de tipos compartilhados app↔backend.
- **Ambientes**: `staging` e `prod` — banco e chaves separados (testar
  Stripe/OAuth sem tocar produção).
- **Linguagem**: TypeScript ponta a ponta (mesmo idioma do app). Um pacote de
  **tipos compartilhados** versionado com o app (`LicenseInfo`, `PlanId`, shape
  dos eventos de XP) para app e backend nunca divergirem no contrato.
- **Observabilidade**: logs estruturados (pino), `/health`, e monitoramento do
  webhook do Stripe (endpoint mais crítico — ver §5).

---

## 3. Identidade & Auth

### Dois tokens (o pulo do gato do local-first)
- **Session token** — opaco (não-JWT), curto (~15 min), renovável, revogável no
  banco. Autentica as chamadas de API (Bearer). Sua expiração offline não afeta
  o funcionamento do app.
- **Licença JWT** — assinada **Ed25519**, longa (~30 dias). Diz o entitlement
  ("Pro até tal data"). O app **verifica OFFLINE** com a chave pública já
  embutida (`NEXUS_LICENSE_PUBKEY`, verificação já implementada em
  `billing-ipc.applyLicenseToken`). Renova sozinho ao reconectar via `/license`.

### Login (Google + GitHub, ambos — reusa o deep link `nexus://`)
```
app: "Entrar com GitHub/Google"
  → abre browser em  <backend>/auth/github  (ou /google)
  → provider OAuth → callback no backend
  → acha/cria conta (MERGE por email verificado — as duas identidades na mesma conta)
  → emite session token + licença JWT
  → redireciona pra  nexus://auth/<session>#<licenca>
  → app captura pelo handler de deep link (novo caso 'auth' em deep-link.ts)
  → guarda no Keychain (safeStorage — mesmo cofre das outras keys)
```
`state` anti-CSRF no OAuth; o token no `nexus://auth` é uso único + expiração
curta na captura.

### Modelo de dados (fundação p/ billing e time)
- `account` — id, email (verificado), nome, avatar, plan, `stripe_customer_id`.
- `identity` — provider (`google`|`github`), `provider_user_id`, → account
  (permite os dois providers na mesma conta).
- `session` — token hash, account, expira, revogado.
- `team` — id, `owner_account_id`, nome (nasce vazio; o plano Team preenche).
- `team_member` — team, account, role. (Criado agora; usado no Billing/Leaderboard.)

---

## 4. Contrato de API (app ↔ backend)

Envelope `{ok, data?, error?}` (o mesmo do app). Bearer nas rotas autenticadas,
**exceto** webhook do Stripe (valida assinatura Stripe) e feed de updates
(público). **[app já chama]** = o app foi escrito esperando este endpoint.

**Auth**
- `GET /auth/:provider` (`github`|`google`) — inicia OAuth (state anti-CSRF).
- `GET /auth/:provider/callback` — troca code, merge por email, emite
  session+licença, redireciona pra `nexus://auth/<session>#<licenca>`.
- `POST /auth/refresh` — session expirado → novo (refresh token opaco).
- `POST /auth/logout` — revoga session.
- `GET /me` — perfil + plano (Bearer).

**Billing** (Stripe)
- `GET /billing/checkout?plan=pro|team` **[app já chama]** — cria Checkout
  Session, redireciona pro Stripe.
- `GET /billing/portal` **[app já chama]** — Customer Portal do Stripe.
- `POST /billing/webhook` — `checkout.session.completed` /
  `customer.subscription.*` → atualiza plano → **emite nova licença JWT** →
  redireciona/entrega via `nexus://license/<token>` (handler **já existe**).
  Idempotente por `event.id`; grava o evento bruto e reprocessa em erro.
- `GET /license` — licença JWT atual (o app renova a cada reconexão).

**Assets** (update feed)
- `GET /updates/darwin/RELEASES.json` **[app já espera via `NEXUS_UPDATE_FEED`]**
  — feed Squirrel.Mac (versão + URL do .zip assinado).
- `GET /updates/download/:file` — serve/redireciona o binário (storage/CDN).

**Leaderboard** (gated, por último)
- `POST /sync/events` — o app manda eventos de XP **com a evidência**; o backend
  **revalida** (não confia no cliente) e grava. Idempotente por `entityKey`.
- `GET /leaderboard/team/:teamId` — ranking do time, pontuado por entrega.

---

## 5. Segurança & operação

- **Chave privada da licença** (Ed25519) — a jóia da coroa: só ela emite
  entitlement válido. **Nunca** no app, nunca no git; injetada por env
  (`LICENSE_PRIVATE_KEY`). A pública correspondente já está no app. **Rotação**:
  gerar novo par → publicar nova pública num update do app → aceitar as duas por
  um período de transição.
- **Secrets por env** (nunca no git): `LICENSE_PRIVATE_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `GITHUB_OAUTH_ID/SECRET`, `GOOGLE_OAUTH_ID/SECRET`,
  `DATABASE_URL`, `SESSION_SIGNING_KEY`, `RESEND_KEY` (email transacional, se
  necessário).
- **Webhook do Stripe** é o endpoint mais crítico (falhar = perder pagamento):
  valida assinatura, idempotente por `event.id`, grava bruto + reprocessa,
  alerta em falha.
- **Anti-cheat (fundação p/ leaderboard)**: o XP que conta para ranking é
  **revalidado no servidor a partir da evidência** gravada nos eventos (o app
  já anexa `{kind:'verification', command, exitCode:0}` nos handoffs verdes) —
  nunca confiar no número que o cliente manda.
- **Privacidade**: leaderboard e sync são **opt-in explícito** (default off). O
  resto do produto vive local; o backend só recebe o que o usuário autorizar.

---

## 6. Casca web mínima (não é a landing)

O backend serve um punhado de páginas funcionais server-rendered (HTML simples,
sem framework pesado, no visual do produto) — **separadas** do site de marketing
(spec própria):
- `/auth/*` — telas de login/consentimento OAuth (na prática, redirects).
- `/return` — "Login feito ✓ — volte pro NexusIDE" (fallback se o deep link não
  abrir sozinho).
- `/pricing` → botões que batem em `/billing/checkout`.
- `/billing/success` e `/billing/cancel` — retorno do Stripe Checkout.

---

## 7. O que muda no APP (encaixes)

Mudanças mínimas no app, na maioria já preparadas:
- `deep-link.ts` ganha o caso `auth` (`nexus://auth/<session>#<licenca>`) —
  hoje trata `license` e `open`; o padrão é o mesmo.
- Guardar session/refresh no Keychain (secrets-store já existe).
- `/license` chamado na reconexão para renovar a licença JWT.
- `NEXUS_UPDATE_FEED` e `NEXUS_LICENSE_PUBKEY` apontados para o backend real
  (hoje flags vazias por padrão — verificação de licença já pronta).
- Sync de XP (Parte gated da gamificação) chama `/sync/events` quando opt-in.

---

## 8. Fora de escopo (specs próprias)

- Specs detalhadas de cada subsistema (Auth primeiro).
- Landing/marketing gamificada (power-scaling) — spec própria.
- Painel de admin/analytics — depois de haver clientes.
- Loja paga de skins (billing de cosmético) — extensão do Billing, quando o
  catálogo de skins existir.

---

## 9. Racional

- **Uma stack (TS) e um deploy** para os 4 subsistemas: um dev só não divide
  contexto; tipos compartilhados com o app matam divergência de contrato.
- **Ordem por receita e risco**: Auth→Billing libera dinheiro cedo; Leaderboard
  (o mais complexo, com anti-cheat) fica por último.
- **Local-first preservado**: a licença JWT assinada dá entitlement offline; o
  backend nunca vira dependência para o app funcionar no Free.
- **Reusa o que já construímos**: deep link `nexus://`, verificação de licença
  Ed25519, evidência nos eventos de XP, flags de backend — os encaixes já
  existem no app esperando o servidor.
