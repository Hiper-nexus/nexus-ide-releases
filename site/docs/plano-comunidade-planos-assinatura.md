# Plano: comunidade mais viva, planos no site e assinatura funcional

Data: 30/09/2026. Dono: orquestrador da missão (pane Claude). Este plano cobre três repositórios:
`nexus-site` (site e comunidade), `nexus-cloud-api` (API em Cloudflare Workers + D1) e `nexus-ide` (app desktop).

## Pedido

1. Comunidade: ícone do WhatsApp na cor oficial, seção do jogo mais viva, carrinho 3D mais dirigível, com explosões e mais interação.
2. Página principal: seção de planos e assinatura ligada ao backend, com o fluxo de assinatura e licença funcionando de ponta a ponta.

Pendências informadas pelo operador na mesma data: concluir checkout e webhooks Stripe e publicar a API; integrar e testar o painel de assinantes; validar login Google e GitHub em produção; aplicar no app os limites do teste e bloquear após expiração ou suspensão; definir os limites finais do teste de 15 dias, sem plano gratuito permanente. Administradores: `admin@volarehost.com.br` e `retornoja@gmail.com`.

## Estado encontrado (verificado em 30/09, 13h40)

- `nexuside.app` e `comunidade.nexuside.app` respondem 200. `nexuside.app/conta/` responde 404: `conta/` e `admin/` existem no código, mas não estão nas entradas do Vite nem nas rotas do Worker.
- `nexuside.app/v1/public/status` responde 404 e `api.nexuside.app` não tem DNS. Nenhum backend está no ar.
- `nexus-cloud-api`: 50 testes passando e `tsc` limpo, mas falta `src/index.ts` (o `main` do `wrangler.jsonc`), billing (checkout, portal, webhook), `/v1/public/status`, `/v1/license` e as rotas `/v1/admin/*`. Auth, sessões, times, cron e sync já estão portados.
- `src/account.js` e `src/admin.js` do site já definem o contrato que a API precisa cumprir.
- A comunidade não tem ícone do WhatsApp hoje; as CTAs do grupo são botões brancos com texto.
- O Wrangler desta sessão não está autenticado na Cloudflare. Publicar depende do operador.
- Os dois repositórios não tinham git. Foi criado um repositório local em cada um com um commit de baseline; nada foi enviado para fora da máquina.

## Contrato da API (fonte única para backend e site)

Base: `https://api.nexuside.app`. Respostas: `{ok:true,data:{…}}` ou `{ok:false,error:"…"}`.
O site chama a API de `https://nexuside.app` com `credentials: include`; a API responde CORS só para essa origem.

| Rota | Autenticação | Resposta `data` |
|---|---|---|
| `GET /health`, `GET /ready` | pública | estado do serviço e do D1 |
| `GET /v1/public/status` | pública | `{ready, auth:{google,github}, billing:{available, amount, currency:'brl', interval:'month'}, trial:{days,maxAgents,cloudSync}}` |
| `GET /v1/web/auth/:provider`, `GET /v1/auth/:provider/callback`, `GET /v1/web/session`, `POST /v1/web/logout` | já existem | sem mudança de contrato |
| `POST /v1/web/checkout` `{plan:'pro',attemptId}` | cookie + CSRF | `{url}` em `checkout.stripe.com`; `attemptId` vira chave de idempotência |
| `POST /v1/web/portal` `{}` | cookie + CSRF | `{url}` em `billing.stripe.com` |
| `POST /v1/billing/checkout` `{plan:'pro'}`, `POST /v1/billing/portal` | Bearer do app | `{url}` |
| `GET /v1/license` | Bearer do app | `{licenca}` (JWT EdDSA com `access`, `trialEndsAt`, `limits`) |
| `POST /v1/billing/webhook` | assinatura Stripe sobre o corpo raw | `{ok:true}`; idempotente por `stripe_events`; o estado vem de `subscriptions.retrieve`, nunca do payload |
| `GET /v1/admin/overview` | cookie + admin | `{accounts,trial,active,suspended,expired}` |
| `GET /v1/admin/accounts?status=all\|trial\|active\|suspended\|expired&limit≤50` | cookie + admin | `{accounts:[{id,email,name,role,access,trialEndsAt,subscriptionStatus}]}` |
| `POST /v1/admin/accounts/:id/suspend` `{reason}`, `/resume` `{}`, `/extend-trial` `{days:1..30}` | cookie + CSRF + admin | `{}`; mutação e `admin_audit` no mesmo `batch` |

Regras que não mudam: preço Pro validado contra o Price do Stripe (BRL, 5.999 centavos, mensal) antes de criar cobrança; nenhum parâmetro de URL eleva acesso; suspensão não cancela a assinatura no Stripe; admin exige e-mail verificado pelo provedor e presente em `ADMIN_EMAILS`.

## Fases

### Fase 1 — Comunidade (nexus-site, branch `feat/comunidade-jogo`)

Arquivos: `comunidade/index.html`, `src/community.js`, `src/community.css`, `src/world/*`, `src/tokens.css` (só o token do WhatsApp), `DESIGN.md` (seções de comunidade).

1. WhatsApp: glifo oficial em SVG inline e cor oficial `#25D366` nas ações que abrem o grupo (nav, convite, painel de estação). Texto escuro sobre o verde, contraste AA. As demais CTAs continuam brancas.
2. Direção do rover: `drive()` continua pura e testada. Curva proporcional à velocidade, direção suavizada, freio de mão com derrapagem, colisão que desliza na parede em vez de parar seco, boost com carga visível. Rodas que giram e esterçam, inclinação da carroceria, câmera que acompanha com folga.
3. Explosões e interação: barris que explodem no impacto (partículas em instância, onda de choque, clarão, tremor de câmera, empurrão no rover, som), objetos empurráveis, rajada de partículas ao coletar café e ao ativar estação, texto flutuante de XP. Nova missão de demolição com XP recalculado em `quests.js`.
4. Palco mais vivo: luzes e sinais animados no mapa, HUD com resposta a cada evento, seções de prêmios e lives com mais presença. Sem emoji, sem texto em gradiente, sem blur como padrão.
5. Limites: `prefers-reduced-motion` sem tremor nem clarão; teclado e toque funcionando; chunk 3D até cerca de 180 kB comprimido; XP continua local e sem relação com o sorteio.

Verificação: `npm test`, `npm run build`, capturas em 390, 800 e 1440 px com o jogo em andamento, direção por teclado e toque testadas no navegador.

### Fase 2 — API (nexus-cloud-api, branch `feat/billing-admin-api`)

1. `src/index.ts`: app Hono com config validada, CORS restrito ao site, rate limit, erros em JSON, `/health`, `/ready`, montagem das rotas e limpeza agendada de registros vencidos.
2. `src/status.ts`: `/v1/public/status` a partir de `authConfigured`, `billingConfigured`, `MIGRATION_READY` e dos limites de teste.
3. `src/billing.ts`: checkout e portal (web e app), webhook com verificação assíncrona da assinatura, `applySubscriptionState` portado para D1 com graça de 7 dias ancorada, idempotência por evento.
4. `src/admin.ts`: resumo, listagem e ações com auditoria.
5. `GET /v1/license` para o app.
6. Testes primeiro para cada rota, com Stripe falso injetado: checkout recusa plano inválido, preço divergente e assinatura já ativa; webhook recusa assinatura inválida, não processa evento duas vezes e reprocessa evento que falhou; admin recusa usuário comum e e-mail não verificado; suspensão bloqueia licença.

Verificação: `npm test`, `npm run typecheck`, `wrangler deploy --dry-run`, fluxo local com `wrangler dev` e D1 local.

### Fase 3 — Planos, conta e administração no site (nexus-site, branch `feat/planos-conta`)

Arquivos: `index.html`, `src/product.js`, `src/product.css`, `src/plans/*`, `src/account.js`, `src/admin.js`, `conta/`, `admin/`, `vite.config.js`, `worker/index.js`, `README.md`, `PRODUCT.md`.

1. Seção `#planos` na principal: teste de 15 dias e Nexus Pro, com preço e limites lidos de `/v1/public/status`. Se a API não confirmar, a seção informa que a contratação está indisponível e não inicia cobrança. CTAs levam a `/conta/`.
2. `conta/` e `admin/` entram no build e nas rotas do Worker; CSP libera `connect-src` para a API; `/conta/?checkout=success|cancel` só informa e consulta a sessão de novo.
3. Remover as menções a plano Free permanente na página principal e no FAQ.
4. Testes do módulo de planos e das novas rotas do Worker.

Verificação: `npm test`, `npm run build`, capturas em 390, 800 e 1440 px, fluxo completo contra a API local.

### Fase 4 — App desktop (nexus-ide, worktree e branch próprios)

Começa com um levantamento somente leitura: como o app lê a licença hoje, onde ficam os limites de agentes e de sync, e onde encaixar o bloqueio. Implementação depois das decisões abaixo, com TDD. Release só com OK do operador.

### Fase 5 — Publicação (depende do operador)

1. `wrangler login` e D1 de produção com as migrations.
2. Secrets na Cloudflare: par de chaves da licença (o mesmo que o app instalado reconhece), Stripe, OAuth, `ADMIN_EMAILS`.
3. Domínio `api.nexuside.app` no Worker da API.
4. URIs de retorno no Google e no GitHub apontando para `https://api.nexuside.app/v1/auth/{provider}/callback`.
5. Endpoint de webhook no Stripe, primeiro em modo de teste.
6. Roteiro de validação: login com os dois provedores, início do teste, checkout com cartão de teste, webhook, licença no app, falha de pagamento, cancelamento, suspensão e restauração pelo painel.
7. Só depois: chaves live e publicação do site com a seção de planos ativa.

## Decisões do operador

| Decisão | Recomendação usada até resposta |
|---|---|
| Limites finais do teste | 15 dias, 6 agentes simultâneos, sem sync em nuvem, resto igual ao Pro |
| O que é "bloquear" no app | Tela de bloqueio: sem terminais, agentes e missões; conta, assinatura e saída continuam acessíveis; arquivos locais intactos |
| Tolerância offline | Teste: até 24 h. Pro: 7 dias. Hoje a API limita todos a 24 h |
| Quem já usa o app sem conta | Passa a exigir login na atualização que trouxer o bloqueio; precisa de aviso antes |
| Verde do WhatsApp | Só nas ações que abrem o WhatsApp; a regra da CTA branca continua para o resto |
