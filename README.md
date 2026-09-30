# Nexus Cloud API

API do NexusIDE em Cloudflare Workers (Hono, D1, Stripe). Atende o site `https://nexuside.app` (conta, assinatura, administração) e o app desktop (login, licença, times, cron, sync). Destino: `https://api.nexuside.app`.

Ainda não está publicada. O roteiro de publicação fica em `docs/go-live.md` e depende do operador.

## Rodar

```sh
npm ci
npm test            # 78 testes TypeScript + 16 de schema
npm run typecheck
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local
npx wrangler deploy --dry-run
```

`npx wrangler types --env-interface=CloudflareBindings --strict-vars=false` regenera `worker-configuration.d.ts` depois de mudar `wrangler.jsonc`.

## Política de acesso

Não existe plano gratuito permanente. O primeiro login verificado (Google ou GitHub) inicia um teste de `TRIAL_DAYS` dias com `TRIAL_MAX_AGENTS` agentes simultâneos. Depois disso, o acesso exige assinatura Nexus Pro (BRL 59,99 por mês). `src/access.ts` é a única fonte da decisão: suspensão vence tudo, depois assinatura paga ou admin autorizado, depois teste em andamento.

Admins são os e-mails de `ADMIN_EMAILS`, e só valem quando o provedor de login confirma o e-mail.

## Rotas

Respostas: `{ok:true,data:{…}}` ou `{ok:false,error:"…"}`.

| Rota | Autenticação |
|---|---|
| `GET /health`, `GET /ready` | pública |
| `GET /v1/public/status` | pública |
| `GET /v1/auth/:provider`, `GET /v1/web/auth/:provider`, `GET /v1/auth/:provider/callback` | OAuth com PKCE |
| `POST /v1/auth/exchange`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/me` | app (Bearer) |
| `GET /v1/web/session`, `POST /v1/web/logout` | site (cookie; mutações com `X-CSRF-Token`) |
| `POST /v1/web/checkout`, `POST /v1/web/portal` | site (cookie + CSRF) |
| `POST /v1/billing/checkout`, `POST /v1/billing/portal`, `GET /v1/license` | app (Bearer) |
| `POST /v1/billing/webhook` | assinatura do Stripe |
| `GET /v1/admin/overview`, `GET /v1/admin/accounts`, `POST /v1/admin/accounts/:id/{suspend,resume,extend-trial}` | site (cookie + admin; mutações com CSRF) |
| `/v1/team`, `/v1/team/*`, `/v1/cron/*`, `/v1/sync/*` | app (Bearer); cron exige teste ou assinatura para gravar, sync exige assinatura |

## Cobrança

- O checkout só aceita o plano `pro` e confere o Price do Stripe (ativo, BRL, 5.999 centavos, mensal) antes de criar cliente ou sessão.
- Enquanto `MIGRATION_READY` for `false`, o checkout responde 503. Portal e webhook continuam funcionando.
- Cada conta tem no máximo uma sessão de checkout aberta. Tentativas repetidas, no site ou no app, recebem a mesma sessão do Stripe por até 23 horas. Ative também, no painel do Stripe, a opção de limitar clientes a uma assinatura.
- Uma assinatura só vale para a conta cujo cliente Stripe foi criado no checkout dela. Assinatura de outro produto, sem dono, de dono inexistente ou com cliente divergente é registrada em `stripe_events` com o motivo e não concede acesso.
- O webhook verifica a assinatura sobre o corpo exato, registra o evento em `stripe_events` e lê o estado atual da assinatura na API do Stripe. O payload do evento nunca decide acesso. Um evento que falha fica sem `processed_at` e o Stripe tenta de novo. Entregas simultâneas não se atropelam: uma leitura antiga nunca sobrescreve uma mais nova.
- Pagamento em atraso mantém o Pro por 7 dias, contados da primeira falha. Novas tentativas do Stripe não estendem esse prazo.
- Suspender uma conta bloqueia o NexusIDE, mas não cancela a assinatura. A conta continua conseguindo abrir o portal de cobrança.

## Configuração

Variáveis em `wrangler.jsonc`. Segredos por `wrangler secret put`: `LICENSE_PRIVATE_KEY`, `LICENSE_PUBLIC_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GITHUB_OAUTH_SECRET`, `GOOGLE_OAUTH_SECRET`. Para rodar local com segredos de teste, use `.dev.vars` (fora do git).

O par de chaves da licença precisa ser o mesmo que os apps instalados reconhecem.
