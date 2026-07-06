# Billing + Team — HANDOFF de execução (para retomar em qualquer sessão/LLM)

> Estado congelado em 2026-07-06. Execução por subagentes (TDD) do plano em
> `docs/superpowers/plans/2026-07-06-billing-team-parte-{1..4}.md`, spec em
> `docs/superpowers/specs/2026-07-06-billing-team-design.md`.

## Estado do git (IMPORTANTE)

- Working tree compartilhado com sessões concorrentes; branch atual:
  `ui/pixel-icons-opsboard` (criada por uma sessão de UI). Os commits do
  Billing estão nela E na `main` (main foi fast-forwarded até `7d866bd`).
- **Commits locais apenas — NÃO fazer push sem o usuário mandar.**
- `git add` SEMPRE por arquivo (nunca `-A`) — há trabalho alheio no tree.
- Antes de editar QUALQUER arquivo: relê-lo (sessões concorrentes mexem).

## ✅ FEITO — Parte 1 e Task 5 (commits verificados, reviews aprovados)

| Task | Commits | Conteúdo |
|------|---------|----------|
| 1. Env Stripe + StripeLike/fake | `2f875bd`+`e1e4509`+`ad7c463` | 5 vars novas no env; `server/src/billing/stripe-like.ts`; dep stripe no lockfile da RAIZ (workspace); lockfile órfão de server/ removido |
| 2. Schema billing+team | `135953c`+`ceab500` | 5 tabelas + 2 enums em `server/src/db/schema.ts` + CREATE_TABLES_SQL; migration REAL `drizzle/0003_billing_team.sql` com journal idx3 + snapshot (drizzle-kit consertado: faltava drizzle-orm na raiz p/ hoisting); fix `isUniqueViolation` p/ `err.cause` (DrizzleQueryError ≥0.38) em account-service |
| 3. subscription-service | `3297342`+`20e978d` | `applySubscriptionState(db, sub, prices, now?)`; **grace ANCORADA** na 1ª observação de past_due (review pegou grace infinita sob retries); cache accounts.plan rebaixa quando grace vence; 6/6 testes |
| 4. entitlement + TTL | `0a363ab`+`3b954ef` | `entitlementFor(db, accountId, now?)` → `{input, ttlSeconds}`; `TTL_PERSONAL` 30d / `TTL_TEAM_MEMBER` 7d; `signLicense` ganhou 4º param ttlSeconds (retrocompatível); empate pessoal-vs-time documentado+testado (pessoal vence) |
| 5. checkout + portal | `7d866bd` | `server/src/billing/billing-routes.ts` + `test-helpers.ts`; index.ts com `AppDeps = AuthDeps & {stripe?}` e boot injetando SDK real; 60/60 na suíte do server, tsc limpo |

Gates na época do freeze: server 60 testes verdes, `tsc --noEmit` limpo.

## 🔴 BACKLOG DE FINDINGS DOS REVIEWS (não perder!)

1. **HIGH (aberto — resolver na Task 6 ou task dedicada ANTES de produção):**
   time+owner são criados ANTES do pagamento no checkout team
   (`billing-routes.ts`); se o Stripe falhar/checkout abandonado, a conta fica
   PERMANENTEMENTE travada pela guarda 409 "você já está num time" (nenhum
   caminho de recuperação existe ainda; o entitlement NÃO vaza plano — é trava
   de conversão, não segurança). Correções candidatas: (a) checkout reusa o
   time pendente do próprio owner (sem subscription viva) em vez de 409;
   (b) reaper de times órfãos sem subscription após N horas; (c) tratar
   `checkout.session.expired` no webhook. Recomendado: (a) + (b).
2. **MEDIUM:** guarda "1 time por conta" no checkout é TOCTOU — double-submit
   vira 500 (violação de unique) em vez de 409. Tratar a violação → 409.
3. **MEDIUM:** `customerFor` é TOCTOU — 2 checkouts concorrentes criam 2
   customers Stripe (órfão no Stripe). Aceitável v1, mas anotar.
4. **Minors acumulados (triagem no review final de branch):** reordenação do
   package.json (T1); nome `team_members_pk` confuso; sem index em FKs; sem
   testes p/ status unpaid/incomplete; no-op silencioso sem accountId no
   cache; cast `plan` evitável no entitlement; N+1 futuro multi-time; teste de
   grace via update direto.

## ⏳ FALTANTE — Tasks 6-12 (planos têm código completo, é seguir literal)

Ordem e onde está cada brief:

| Task | Plano | O quê |
|------|-------|-------|
| 6. Webhook idempotente | parte-2 (Task 6) | `webhook-routes.ts`: raw body ANTES do json no index.ts; INSERT stripe_events ON CONFLICT; busca estado ATUAL na API; `applySubscriptionState`. **Incluir aqui o fix do HIGH acima.** |
| 7. GET /v1/license + team-service | parte-3 (Task 7) | `license-routes.ts` (entitlement→JWT); `team-service.ts` (convite hasheado AB12-CD34, `joinTeam` atômico com `pg_advisory_xact_lock` — corrida do último assento) |
| 8. team-routes + LGPD | parte-3 (Task 8) | 6 rotas /v1/team/*; guarda 409 no DELETE /me de owner com sub viva |
| 9. contract + api-client (app) | parte-4 (Task 9) | tipos TeamInfo etc em shared/contract.ts; `src/main/api-client.ts` (Bearer + 401→refresh→retry, nunca lança) |
| 10. billing-ipc real + license-sync | parte-4 (Task 10) | checkout/portal via backend; polling 5s×24 pós-checkout; sync no boot; exportar `currentPlan()` |
| 11. IPC/UI de team | parte-4 (Task 11) | TEAM_CHANNELS + preload + team-ipc.ts + bloco no AccountSection (RELER esses arquivos — mudam MUITO por sessões concorrentes) |
| 12. páginas web + gates finais | parte-4 (Task 12) | `server/src/web/pages.ts` (success/cancel/join, anti-reflexo de input); gates: server vitest+tsc E raiz npm test+typecheck |

Depois da 12: **review final de branch inteira** (diff `0972ce9..HEAD` do
billing) triando os Minors do backlog acima; fixes num único subagente.

## Protocolo de execução (o que manteve a qualidade até aqui)

- TDD estrito por task: teste RED → implementa → GREEN → commit (mensagens
  em pt-BR, tipo `feat(server): ...`).
- Cada task: implementar → REVIEW independente contra o brief (não contra o
  report) → fixes de Critical/Important → re-review → só então avançar.
  Os reviews pegaram 2 Criticals e 1 HIGH reais até agora — não pular.
- NUNCA mencionar concorrentes em código/comentários/docs.
- Testes server: `cd server && npx vitest run [arquivo]`; typecheck
  `npx tsc --noEmit`. App (raiz): `npm test` / `npm run typecheck`.
- pglite + deps injetadas (fake Stripe em `stripe-like.ts::makeFakeStripe`);
  padrões atômicos anti-TOCTOU (`UPDATE ... WHERE ... RETURNING`).
- Ledger de progresso da sessão SDD (gitignored): `.superpowers/sdd/progress.md`
  — briefs/reports por task em `.superpowers/sdd/task-N-{brief,report}.md`.
