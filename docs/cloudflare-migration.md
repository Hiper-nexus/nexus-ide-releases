# Nexus: migração para Cloudflare e prontidão comercial

Levantamento em 30/09/2026. Este documento separa evidência atual de arquitetura proposta. Não certifica segurança nem operação em produção.

## Estado confirmado

- Cloudflare: acesso MCP e Wrangler autenticados, conta `53446ce31f241717e814d3766cb43305`.
- Zona `nexuside.app` ativa, id `8e4c8f181ef7eb560356469f349cea09`.
- DNS raiz aponta para `kbullbww.up.railway.app`; no levantamento, `/` respondeu 404 com `x-railway-fallback: true`.
- O endereço padrão do app é `https://api.nexuside.app`. Em 30/09 esse hostname não resolveu no teste de rede e não apareceu nos registros DNS da zona. É um bloqueador operacional a resolver antes de validar o licenciamento online.
- `app.nexuside.app/*` já possui a rota Cloudflare `nexus-companion`. Essa rota deve ser preservada.
- Railway: projeto `awake-reflection`, serviços `@nexus/server`, `Postgres` e `nexus-relay`.
- Backend: Node/Express, Drizzle com driver `pg`, esquema PostgreSQL. Licenciamento, Stripe, OAuth, times, cron e sync estão nesse backend.
- Chaves de licença, OAuth e Stripe estão configuradas como variáveis na Railway. Os valores não foram expostos neste levantamento.

## Landing entregue como primeira etapa

Projeto independente em `/Users/cleofasrocha/dev/nexus-site`. Three.js original, Vite, assets estáticos e um Worker com passthrough temporário dos caminhos do backend no domínio raiz. Nenhuma alteração de código foi feita no repositório NexusIDE.

O Worker serve a home e os aliases `/comunidade` e `/sorteio`. `/v1/*`, `/billing/*`, `/join/*`, `/health` e `/ready` continuam sendo resolvidos pela origem atual quando a requisição é para `nexuside.app`. O domínio de preview não expõe esse proxy. Isso é uma etapa transitória e NÃO significa que o banco/API/relay foram migrados.

Publicação confirmada em 30/09/2026: `https://nexuside.app/` e `/comunidade` retornam 200 a partir dos assets Cloudflare; `/sorteio` retorna 200 com `X-Robots-Tag: noindex`. A rota `nexuside.app/*` aponta para `nexus-community-site`; a rota existente `app.nexuside.app/*` continua com `nexus-companion`. Preview: `https://nexus-community-site.navalhago.workers.dev`. `/ready` ainda retorna o 404 da origem Railway, como antes da etapa do site.

Validação da landing: build concluído, 10 testes passando; navegador com 3D, coleta por teclado, abertura de estação e layout móvel verificados. O módulo 3D pesa aproximadamente 142 kB comprimido e é carregado separado do HTML/conteúdo. Ainda não houve medição formal de Core Web Vitals.

## Destino para retirar a Railway

| Parte | Destino proposto | Trabalho necessário |
|---|---|---|
| Site e LP | Workers Static Assets | Publicar assets e associar rota do domínio |
| API, login, billing, licença | Workers | Adaptar runtime, ciclo de conexão, erros e limites |
| Dados de contas, sessões, times e sync | D1 | Portar schema/consultas PostgreSQL para SQLite, preservando invariantes |
| Relay WebSocket | Durable Objects | Preservar protocolo, isolamento por sala e reconexão |
| Arquivos/exports/backups | R2, onde houver necessidade comprovada | Definir acesso e retenção; não tornar backups públicos |
| Segredos | Secrets/bindings | Transferir sem logs, validar presença e política de rotação |

D1 não é PostgreSQL. Enums, UUID defaults, timestamps, JSONB e transações usadas pelo backend precisam de revisão. Hyperdrive conecta um PostgreSQL existente e não elimina a hospedagem do banco. Containers podem reaproveitar Node, mas o disco é efêmero por padrão; não usar isso como substituição automática do banco persistente.

Fontes oficiais: [Static Assets](https://developers.cloudflare.com/workers/static-assets/), [D1](https://developers.cloudflare.com/d1/), [Hyperdrive](https://developers.cloudflare.com/hyperdrive/get-started/), [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Containers FAQ](https://developers.cloudflare.com/containers/faq/).

## Critérios de migração do banco

1. Medir dados, usuários ativos e escritas por fluxo; esse levantamento não consultou registros de clientes.
2. Fazer backup protegido e provar restauração antes do cutover.
3. Construir D1 de homologação com migrations e conversor idempotente, preservando IDs e hashes de sessão.
4. Comparar contagens, referências, assinaturas e casos de concorrência. Nunca copiar secrets para assets.
5. Definir janela de parada de escritas ou mecanismo de sincronização de deltas e reversão.
6. Validar API/app contra homologação antes de trocar DNS/rotas.
7. Encerrar Railway apenas depois da validação em produção e de um período de observação.

## Licenciamento: evidência e validação pendente

Existe emissão Ed25519 no backend e verificação de assinatura no Main, planos Free/Pro/Team, sessões por token hash e direitos por conta/time. Isso é base implementada, não prova de lançamento comercial.

Validação local já executada:

```sh
npx vitest run --config server/vitest.config.ts \
  server/src/auth/license-signer.test.ts \
  server/src/auth/session-service.test.ts \
  server/src/billing/license-routes.test.ts \
  server/src/billing/entitlement.test.ts \
  server/src/sync/sync-routes.test.ts \
  server/src/team/team-routes.test.ts
```

Resultado: 6 arquivos, 29 testes passando. Também foram executados `src/main/persistence/billing-license.test.ts` e `src/main/license-sync.test.ts`, com mais 11 testes passando. Total observado: 40 testes em 8 arquivos. Isso não prova integração com Stripe, OAuth ou app empacotado em produção.

Antes de vender para vários usuários:

- Provar login GitHub/Google no app instalado, exchange PKCE, refresh, logout e reconexão.
- Provar que a chave pública de licença está disponível e pinada no artefato instalado. Hoje `licensePublicKey()` lê `NEXUS_LICENSE_PUBKEY` do ambiente; não foi provado seu fornecimento ao app distribuído.
- Validar vínculo da licença à identidade autenticada, expiração obrigatória, emissor/destinatário, renovação e rotação de chave. O contrato atual carrega plano/email/status/exp; ainda exige análise para resistência à cópia entre contas.
- Provar compra, ativação, webhook assinado/idempotente, cancelamento, inadimplência e revogação no prazo definido.
- Definir janela offline consciente: o backend atualmente emite TTL pessoal de 30 dias e de membro do time de 7 dias.
- Testar com duas contas reais de homologação que uma não acessa dados, projetos, licença ou time da outra.
- Testar concorrência e recuperação em refresh, convites, sincronização e leases cron durante a portabilidade para D1.
- Provar isolamento e limites do relay, sem acesso cruzado a salas.
- Monitorar erros, latência, backups e rollback com procedimentos operacionais claros.

Leitura de origem: `server/src/auth/license-signer.ts`, `server/src/billing/entitlement.ts`, `server/src/auth/session-service.ts`, `server/src/sync/sync-service.ts`, `src/main/persistence/billing-ipc.ts` e `shared/contract.ts` no NexusIDE.

## Decisões de campanha pendentes

- A data será anunciada no grupo conforme ele crescer; não há meta numérica definida.
- Claude: 20x por 1 mês.
- Codex: 20x; duração ainda não confirmada pelo organizador.
- Antes do sorteio efetivo, a organização precisa anunciar regras completas, elegibilidade, seleção e entrega.

## Redesenho posterior na mesma data
O domínio principal passou a ser o site de produto. A comunidade foi separada em `comunidade.nexuside.app`, com jogo de primeira tela. A configuração mantém um Worker multipage e dois hostnames; não migra API ou banco. O vídeo original do usuário está no principal. Os detalhes atuais estão em `docs/site-redesign-brief.md`.
