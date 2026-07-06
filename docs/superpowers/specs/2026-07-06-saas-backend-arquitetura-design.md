# SaaS Backend NexusIDE — Arquitetura compartilhada (design)

Data: 2026-07-06 · Status: design aprovado (rev. 2, pós-review adversarial),
aguardando specs dos subsistemas.

Spec-guarda-chuva: a **fundação comum** que os quatro subsistemas do backend
herdam. Não é implementável sozinha — define stack, identidade, contrato e
deploy que Auth / Billing / Assets / Leaderboard reusam. Cada subsistema ganha
sua própria spec detalhada → plano → build.

O app NexusIDE é **local-first** e continua assim: o backend só liga as camadas
já desenhadas como *gated* (billing/licença, leaderboard de time, update feed).
Sem backend, o app funciona 100% offline no plano Free.

---

## 1. Subsistemas & ordem

1. **Auth / Contas** (fundação — pré-requisito dos outros): identidade, login,
   **conta individual**. *(Times NÃO entram aqui — ver §7.)*
2. **Billing + Licença** (traz receita): Stripe → emitir a licença JWT que o app
   já verifica. Destrava Pro/Team. O modelo de **time** (convites, papéis,
   billing centralizado) é modelado NESTE subsistema, junto do plano Team.
3. **Assets** (update feed): o feed do auto-updater que o app já espera.
4. **Leaderboard** (gated, por último — mais complexo): sync de XP com
   revalidação por evidência, ranking de time.

Receita entra assim que 1+2 saem; leaderboard não bloqueia monetização.

---

## 2. Stack, banco & deploy

- **Runtime**: Node + **Express** num container (Dockerfile), rodando 24/7 —
  processo sempre quente (bom para o WebSocket futuro do leaderboard).
- **Host**: Fly.io / Railway / VPS. Deploy num `git push`. `GET /health`.
- **Banco**: **Postgres gerenciado** (Fly PG / Neon / Railway). ORM + migrations
  em **Drizzle** (schema tipado em TS, migrations versionadas, rodadas no
  deploy) — casa com a filosofia de tipos compartilhados app↔backend.
- **Ambientes**: `staging` e `prod` — banco e chaves separados.
- **Versionamento de API (rev#10)**: TODAS as rotas sob prefixo **`/v1`**. Um
  app antigo batendo num backend novo deve continuar funcionando; o backend
  tolera licença/schema de versão anterior e nunca quebra um cliente que não
  atualizou. Major novo só com `/v2` coexistindo.
- **Linguagem**: TypeScript ponta a ponta. Pacote de **tipos compartilhados**
  versionado com o app (`LicenseInfo`, `PlanId`, shape dos eventos de XP).
- **Observabilidade**: logs estruturados (pino), `/health`, monitoramento do
  webhook do Stripe (§5).

---

## 3. Identidade & Auth

### Dois tokens (o pulo do gato do local-first)
- **Session token** — opaco (não-JWT), curto (~15 min), renovável, revogável no
  banco. Autentica as chamadas de API (Bearer). Expiração offline não afeta o
  app.
- **Licença JWT** — assinada **Ed25519**, longa (~30 dias). Diz o entitlement
  ("Pro até tal data"). O app **verifica OFFLINE** com a chave pública embutida
  (`NEXUS_LICENSE_PUBKEY`, já implementado em `billing-ipc.applyLicenseToken`).
  Renova sozinho ao reconectar via `/v1/license`.

### Login (Google + GitHub — via `nexus://` + CODE-EXCHANGE, rev#1)
```
app: "Entrar com GitHub/Google"
  → abre browser em  <backend>/v1/auth/github  (ou /google)
  → provider OAuth → callback no backend (valida state anti-CSRF)
  → acha/cria conta (merge — regra abaixo)
  → gera um CODE de uso único, curtíssimo (~60s), guardado no banco
  → redireciona pra  nexus://auth/<code>          ← só o code, NUNCA o token
  → app captura o code pelo deep link (novo caso 'auth' em deep-link.ts)
  → app troca via  POST /v1/auth/exchange {code}  → { session, refresh, licenca }
  → app guarda no Keychain (safeStorage)
```
**Por quê code-exchange e não token na URL:** deep links vazam em logs do SO e
no histórico de processo. O code é efêmero/uso único; o token longo
(session/licença) só trafega no corpo de um POST HTTPS, jamais numa URL.

### Merge de conta seguro (rev#2 — anti account-takeover)
Merge automático de duas identidades na mesma conta **somente** quando **ambos**
os provedores marcam o email como **verificado** e ele coincide. Se um dos lados
não confirma o email como verificado, **não** faz merge automático: exige que o
usuário **já logado** confirme a vinculação no app (`POST /v1/auth/link`,
autenticado). Nunca vincular por email não-verificado.

### Modelo de dados (fundação — conta individual)
- `account` — id, email (verificado), nome, avatar, plan, `stripe_customer_id`.
- `identity` — provider (`google`|`github`), `provider_user_id`, `email_verified`
  (do provider), → account.
- `session` — token hash, account, expira, revogado.
- `refresh_token` — hash, account, `rotated_from` (cadeia), usado, expira.
- *(Times: `team`/`team_member` NÃO aqui — modelados no subsistema Billing/Team.)*

---

## 4. Contrato de API (app ↔ backend) — tudo sob `/v1`

Envelope `{ok, data?, error?}`. Bearer nas rotas autenticadas, **exceto** webhook
do Stripe (valida assinatura Stripe) e feed de updates (público). **[app já
chama]** = o app foi escrito esperando o endpoint (a base muda de path p/ incluir
`/v1`).

**Auth**
- `GET /v1/auth/:provider` (`github`|`google`) — inicia OAuth (state anti-CSRF).
- `GET /v1/auth/:provider/callback` — troca o code OAuth, aplica merge, gera o
  code de uso único, redireciona pra `nexus://auth/<code>`.
- `POST /v1/auth/exchange` — `{code}` → `{session, refresh, licenca}`.
- `POST /v1/auth/refresh` — **rotação (rev#6)**: cada uso emite refresh novo e
  invalida o anterior; refresh reusado = sessão comprometida → revoga toda a
  cadeia da conta.
- `POST /v1/auth/link` — vincula um 2º provider à conta logada (quando o merge
  automático não pôde acontecer).
- `POST /v1/auth/logout` — revoga session + refresh.
- `GET /v1/me` — perfil + plano (Bearer).
- `DELETE /v1/me` — **(rev#8, LGPD)** exclui a conta e apaga dados pessoais
  (identidades, sessões, eventos de XP sincronizados; vínculo Stripe anonimizado
  conforme retenção fiscal). Confirmação forte antes.

**Billing** (Stripe)
- `GET /v1/billing/checkout?plan=pro|team` **[app já chama]** — Checkout Session.
- `GET /v1/billing/portal` **[app já chama]** — Customer Portal.
- `POST /v1/billing/webhook` — `checkout.session.completed` /
  `customer.subscription.*` → atualiza plano → **emite nova licença JWT** →
  entrega via `nexus://license/<token>` (handler já existe).
  **Idempotente por `event.id` E tolerante a ordem (rev#5):** eventos do Stripe
  chegam fora de sequência — aplicar sempre o **estado mais recente** da
  assinatura (buscar na API do Stripe no processamento ou comparar timestamp do
  evento), nunca assumir ordem. Grava o evento bruto e reprocessa em erro.
- `GET /v1/license` — licença JWT atual (o app renova a cada reconexão).

**Assets** (update feed)
- `GET /v1/updates/darwin/RELEASES.json` **[app já espera via `NEXUS_UPDATE_FEED`]**
  — feed Squirrel.Mac (versão + URL do .zip assinado).
- `GET /v1/updates/download/:file` — serve/redireciona o binário (storage/CDN).

**Leaderboard** (gated, por último)
- `POST /v1/sync/events` — eventos de XP **com evidência**; o backend
  **revalida** (não confia no cliente). Idempotente por `entityKey`.
- `GET /v1/leaderboard/team/:teamId` — ranking do time, por entrega.

---

## 5. Segurança & operação

- **Chave privada da licença** (Ed25519) — a jóia da coroa: só ela emite
  entitlement válido. Nunca no app/git; env `LICENSE_PRIVATE_KEY`. A pública já
  está no app. **Rotação**: gerar novo par → publicar pública num update do app →
  aceitar as duas por um período de transição.
- **Entitlement offline confia no relógio local (rev#4):** a verificação offline
  usa o relógio da máquina, que o usuário controla (adiantar o relógio estende a
  licença/trial). É **honor-system offline aceito**, mitigado por: (a) quando
  ONLINE o backend é a verdade e corrige; (b) TTL curto (~30 dias) limita a
  janela de abuso; (c) o que conta para ranking é revalidado no servidor, não
  vale relógio de cliente.
- **Grace period & trial (rev#3):** a licença carrega `graceUntil` **distinto**
  de `renewsAt`. Pagamento falho (`past_due`) **mantém Pro até `graceUntil`**
  (ex.: +7 dias) antes de rebaixar — ninguém perde acesso no meio do trabalho por
  cartão vencido. Trial do Pro (se houver) = licença Pro com `renewsAt` = fim do
  trial e sem assinatura Stripe ativa; ao expirar sem conversão, rebaixa p/ Free.
- **Secrets por env** (nunca no git): `LICENSE_PRIVATE_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `GITHUB_OAUTH_ID/SECRET`, `GOOGLE_OAUTH_ID/SECRET`,
  `DATABASE_URL`, `SESSION_SIGNING_KEY`, `RESEND_KEY`.
- **Rate limiting (rev#9):** `/v1/auth/*` e `/v1/auth/exchange` são alvos de
  brute-force → limite por IP (espelhar o padrão da `remote-bridge` do app:
  janela deslizante, teto por IP, backoff). Webhook e feed com limites próprios.
- **Webhook do Stripe** é o endpoint mais crítico (falhar = perder pagamento):
  valida assinatura, idempotente, tolerante a ordem, alerta em falha.
- **Anti-cheat (fundação p/ leaderboard):** XP de ranking revalidado no servidor
  a partir da **evidência** gravada nos eventos (o app já anexa
  `{kind:'verification', command, exitCode:0}` nos handoffs verdes).
- **Privacidade:** leaderboard e sync são **opt-in explícito** (default off).

---

## 6. Casca web mínima (não é a landing)

Páginas funcionais server-rendered (HTML simples, no visual do produto),
**separadas** do site de marketing (spec própria):
- `/v1/auth/*` — telas de login/consentimento OAuth (redirects).
- `/return` — "Login feito ✓ — volte pro NexusIDE" (fallback do deep link).
- `/pricing` → botões que batem em `/v1/billing/checkout`.
- `/billing/success` e `/billing/cancel` — retorno do Stripe Checkout.

---

## 7. Times — adiado de propósito (rev#7)

`team`/`team_member` (convites, papéis, billing centralizado) NÃO estão na
fundação Auth. O modelo real de time é complexo e casado com o plano **Team** —
será desenhado no subsistema **Billing/Team**, não chutado agora. A fundação fica
enxuta (conta individual) e evita schema que mudaria.

---

## 8. O que muda no APP (encaixes)

Mudanças mínimas, a maioria já preparada:
- `deep-link.ts` ganha o caso `auth` (`nexus://auth/<code>`) — hoje trata
  `license` e `open`; mesmo padrão, agora com **code-exchange**.
- Guardar session/refresh/licença no Keychain (secrets-store já existe).
- `POST /v1/auth/exchange` na captura; `GET /v1/license` na reconexão.
- `NEXUS_UPDATE_FEED` e `NEXUS_LICENSE_PUBKEY` apontados para o backend real.
- Sync de XP (parte gated da gamificação) chama `/v1/sync/events` quando opt-in.

---

## 9. Fora de escopo (specs próprias)

- Specs detalhadas de cada subsistema (**Auth primeiro**).
- Modelo de time real (subsistema Billing/Team).
- Landing/marketing gamificada (power-scaling) — spec própria.
- Painel admin/analytics — depois de haver clientes.
- Loja paga de skins — extensão do Billing.

---

## 10. Racional

- **Uma stack (TS) e um deploy** para os 4 subsistemas; tipos compartilhados com
  o app matam divergência de contrato.
- **Ordem por receita e risco**: Auth→Billing libera dinheiro cedo; Leaderboard
  (anti-cheat) por último.
- **Local-first preservado**: licença JWT assinada dá entitlement offline; o
  backend nunca vira dependência para o Free funcionar.
- **Reusa o que já construímos**: deep link `nexus://`, verificação Ed25519,
  evidência nos eventos, flags de backend — os encaixes já existem no app.
- **Segurança por padrão (rev.2)**: code-exchange em vez de token na URL, merge
  só com email verificado dos dois lados, rotação de refresh, rate-limit,
  grace/trial, `/v1` versionado e LGPD (`DELETE /me`) desde a fundação.
