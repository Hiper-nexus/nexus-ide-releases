# Publicar a API e abrir assinaturas do NexusIDE

Roteiro operacional. Revisado em 30/09/2026 contra o código e as fontes oficiais ao final; revisado de novo em 01/10/2026 contra o estado real da produção. Os comandos abaixo são para o operador executar. A elaboração deste documento não publicou serviços nem configurou contas externas.

Destino: Worker `nexus-cloud-api`, API `https://api.nexuside.app`, site `https://nexuside.app`. Oferta: Nexus Pro por R$ 59,99/mês, em BRL. O teste do Nexus dura 15 dias, permite 2 agentes simultâneos e não permite sync em nuvem. Não existe Free permanente. O valor interno `plan=free` não significa acesso gratuito sem prazo.

Execute uma etapa por vez. Pare quando a conferência falhar. Substitua os marcadores `<...>` antes de executar. IDs, arquivos de credenciais e chaves usam placeholders. Endereços públicos, preço e parâmetros da oferta são as constantes decididas para o produto.

Avisos por e-mail do teste (boas-vindas e fim do teste, via Resend): já estão no código e **desligados**. Aplique a migração `0006` junto com as demais e, quando for conectar o Resend, siga `docs/emails.md`; nada é enviado antes de `EMAIL_ENABLED` virar `"true"`.

## 1. Pré-requisitos

### 1.1 Separar acessos e contas de ensaio

Tenha em mãos:

| Item | Onde obter | Como conferir |
| --- | --- | --- |
| Conta Cloudflare com Workers, D1 e gestão da zona `nexuside.app` | Dashboard Cloudflare | A zona está ativa e a conta é a indicada em `wrangler.jsonc`. Não copie IDs de outra conta. |
| Stripe do produto, ambiente de teste e acesso live | Dashboard Stripe | Anote separadamente o ambiente, Product, Price e destino de webhook de cada modo. |
| Projeto Google e cliente OAuth de aplicação Web | Google Auth Platform | Você consegue editar os URIs de retorno e os usuários de teste. |
| OAuth App GitHub | Settings > Developer settings > OAuth Apps | Você consegue editar o callback e obter Client ID e Client secret. |
| Par Ed25519 de licença ou acesso seguro à Railway | Cofre de segredos e projeto Railway antigo | A chave pública correspondente é a reconhecida pelo app que será distribuído. Veja 2.3. |
| Administradores | Lista aprovada pelo operador | `ADMIN_EMAILS` deve conter somente `admin@volarehost.com.br` e `retornoja@gmail.com`. Os provedores precisam confirmar esses e-mails. |
| Duas contas comuns de ensaio e uma administrativa | Google/GitHub | As contas comuns ficam fora de `ADMIN_EMAILS`. Admin recebe Pro sem pagar e não serve para provar compra. |
| Instalador do Nexus que será lançado | Artefato de release | Instale e abra pelo caminho normal do sistema. Um app iniciado por terminal com variáveis extras não prova o instalador. |
| Diretório privado de operação fora dos repositórios | Cofre/local protegido do operador | Restrinja o acesso. Guarde PEMs, backups e registro de versões aqui, nunca em `dist`, Git ou capturas de tela. |

Não desligue a Railway nesta preparação. A autorização para começar com D1 vazio consta em [postgres-to-d1.md](./postgres-to-d1.md). Ela não autoriza apagar uma base que entretanto recebeu usuários reais.

### 1.2 Preparar o terminal comum

Use Terminal/iTerm do operador. Os panes do Nexus não têm a sessão Wrangler desse terminal. Use Node 22 compatível com o projeto e Wrangler atual. Caso falte Wrangler, siga a [instalação oficial][w-install]. A API não declara Wrangler em suas dependências; não presuma que `npm ci` o instalou.

```sh
cd /Users/cleofasrocha/dev/nexus-cloud-api
node --version
wrangler --version
stripe version
npm ci
npm run typecheck
npm test
wrangler login
wrangler whoami
```

Conferência: testes e typecheck terminam com código 0; `whoami` mostra a conta Cloudflare correta. Um login feito só no navegador não substitui `wrangler login`. Não rode `deploy` se houver erro de compilação. A API não tem script `build` nem `lint`; a conferência do bundle será `deploy --dry-run`. Fontes: [npm ci][npm-ci], scripts de `package.json`, [login e whoami][w-general].

### 1.3 Registrar a configuração antes da mudança

No registro privado da operação, anote os IDs das versões atuais dos dois Workers em Workers & Pages > Worker > Deployments. Anote bindings D1, nomes das chaves no cofre, callbacks OAuth e destinos Stripe. Guarde uma cópia da configuração pública atual. Não registre o conteúdo dos segredos.

Conferência: outra pessoa deve conseguir identificar qual banco e qual conjunto de credenciais pertencem a teste e a live. `APP_MODE=staging` é só configuração da aplicação. O código não usa essa variável para impedir cobranças live. A segurança depende da chave Stripe, do banco, dos controles de acesso e de `MIGRATION_READY` corretos.

## 2. Etapa de teste com Stripe em modo de teste

### 2.1 Decidir os bancos antes de cadastrar usuários

O binding `DB` aponta hoje para `nexus-cloud-staging`, que já tem as quatro migrations aplicadas (`schema_version` 4, conforme o levantamento de 01/10/2026). Não existe banco de produção separado ainda. Escolha e registre uma das opções:

| Decisão | Banco de teste | Banco que receberá vendas reais |
| --- | --- | --- |
| Criar produção separada, recomendado | `nexus-cloud-staging`, após conferir seu conteúdo | Novo banco `<NOME_D1_PRODUCAO>` |
| Usar o banco existente como produção | Novo banco `<NOME_D1_TESTE>` | Reservar `nexus-cloud-staging` vazio para a virada |

Use dois bancos distintos. Clientes e assinaturas Stripe de teste não podem virar registros live por troca de chave. Nesta API, `stripe_customer_id` e as assinaturas não têm uma coluna de ambiente. Uma assinatura de teste deixada no banco pode conceder Pro ou bloquear novo checkout após a virada.

```sh
wrangler d1 list
wrangler d1 execute nexus-cloud-staging --remote --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```

Se houver `accounts`, `subscriptions` ou `stripe_events`, confira suas contagens antes de decidir:

```sh
wrangler d1 execute nexus-cloud-staging --remote --command "SELECT 'accounts' AS tabela,count(*) AS total FROM accounts UNION ALL SELECT 'subscriptions',count(*) FROM subscriptions UNION ALL SELECT 'stripe_events',count(*) FROM stripe_events;"
```

Conferência: base nova pode ter apenas tabelas internas. Se houver dados desconhecidos, preserve a base e crie outra. Não use `DROP`, `DELETE` ou restauração sobre ela para obter uma base vazia.

Crie somente o banco novo exigido pela opção escolhida:

```sh
wrangler d1 create <NOME_D1_NOVO>
```

Registre o nome e UUID retornados. No `wrangler.jsonc`, configure **o banco de teste**:

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "<NOME_D1_TESTE_ESCOLHIDO>",
  "database_id": "<UUID_D1_TESTE>",
  "migrations_dir": "migrations"
}]
```

Conferência: o nome e UUID correspondem à mesma linha de `wrangler d1 list`. Preserve `binding: DB`. Não crie um ambiente `--env production` implícito; o arquivo atual não define esse ambiente. Sintaxe: [comandos D1][w-d1].

### 2.2 Aplicar migrations e conferir o esquema

Antes de alterar uma base com conteúdo, exporte-a para um caminho privado novo:

```sh
wrangler d1 export <NOME_D1_TESTE_ESCOLHIDO> --remote --output '<DIR_PRIVADO>/antes-migrations-teste.sql'
wrangler d1 migrations list DB --remote
wrangler d1 migrations apply DB --remote
wrangler d1 migrations list DB --remote
wrangler d1 execute DB --remote --command "SELECT value FROM system_metadata WHERE key='schema_version';"
wrangler d1 execute DB --remote --command "PRAGMA foreign_key_check;"
wrangler d1 execute DB --remote --command "PRAGMA table_info(accounts);"
wrangler d1 execute DB --remote --command "PRAGMA table_info(oauth_states);"
```

Conferência: as quatro migrations foram aplicadas pelo ledger, nesta ordem: `0001_core.sql` → `0002_trial_admin.sql` → `0003_checkout_reservation.sql` → `0004_oauth_client.sql`; nenhuma pendente, versão `4`, nenhum resultado de `foreign_key_check`, `accounts` com as colunas `checkout_generation` e `checkout_open_until` e `oauth_states` com a coluna `client`. `/ready` não prova nada disso: ele executa uma única consulta e não valida a versão; com só `0001`/`0002` aplicadas a API sobe e falha depois com "no such column". `migrations apply` aplica o diretório inteiro: não reaplique arquivos por fora do ledger. Não execute os arquivos SQL de novo por fora do ledger. Se uma migration falhar, pare e investigue; as migrations anteriores podem já ter sido aplicadas. O export contém dados pessoais e hashes de sessão e deve ficar privado. Fontes: [D1][w-d1], [exportação][w-export] e [contrato local](./postgres-to-d1.md).

### 2.3 Resolver a identidade das licenças

O backend importa `LICENSE_PRIVATE_KEY` como PEM PKCS8 Ed25519. Configure `LICENSE_PUBLIC_KEY` como PEM SPKI correspondente. O app lê `NEXUS_LICENSE_PUBKEY` em `src/main/persistence/billing-ipc.ts`. O nome da variável do app é diferente do nome da API.

**Opção A: reaproveitar o par da Railway.** No projeto Railway antigo, abra o serviço da API > Variables. Recupere a chave privada pelo canal seguro do operador. Obtenha a pública correspondente do cofre/build. Não copie para o terminal, chat ou este documento. Guarde como `<DIR_PRIVADO>/license-private.pem` e `<DIR_PRIVADO>/license-public.pem`, com acesso restrito.

Consequência: apps que já reconhecem essa pública continuam aceitando a assinatura. Isso não preserva sessões do PostgreSQL. Com D1 vazio, haverá novo login. **Não confirmado:** acesso atual ao segredo Railway e fornecimento da pública ao app instalado. Confira no projeto Railway e no artefato do app, não só no código-fonte.

**Opção B: gerar outro par e lançar app compatível.** Execute uma única vez em diretório privado existente. O modo `wx` impede sobrescrever arquivos existentes:

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const pair = generateKeyPairSync('ed25519');
writeFileSync('<DIR_PRIVADO>/license-private.pem', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
writeFileSync('<DIR_PRIVADO>/license-public.pem', pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o600 });
console.log('Par criado. Nenhuma chave foi impressa.');
NODE
```

Consequência: apps com a pública antiga recusam as novas licenças. Lance e valide uma versão com a nova pública em `NEXUS_LICENSE_PUBKEY` antes de vender. Alterar uma variável só no terminal do desenvolvedor não atualiza apps instalados. A privada nunca vai no app. A entrega da nova versão não faz parte deste roteiro.

Nas duas opções, obtenha do processo de release a pública efetiva do app como `<DIR_PRIVADO>/app-license-public.pem`. Confira as três peças sem imprimi-las:

```sh
node --input-type=module <<'NODE'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const privateKey = createPrivateKey(readFileSync('<DIR_PRIVADO>/license-private.pem'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('A chave não é Ed25519');
const der = key => createPublicKey(key).export({ type: 'spki', format: 'der' });
const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
for (const name of ['license-public.pem', 'app-license-public.pem']) {
  if (!derived.equals(der(readFileSync(`<DIR_PRIVADO>/${name}`)))) throw new Error(`Pública divergente: ${name}`);
}
console.log('Par e pública do app conferem. Falta provar o app instalado.');
NODE
```

Conferência: código 0 e a mensagem de igualdade. A prova final é 2.11. Não copie uma pública para o arquivo do app só para fazer a comparação passar. Fontes: [Node crypto][node-crypto], `src/licences.ts` e os arquivos do app indicados em 6.2.

### 2.4 Cadastrar Google e GitHub OAuth

No Google Cloud, escolha o projeto > Google Auth Platform. Configure Branding e Audience. Em teste, cadastre os usuários de ensaio. Em Clients, crie/edite um cliente do tipo **Web application**. Em **Authorized redirect URIs**, informe exatamente:

```text
https://api.nexuside.app/v1/auth/google/callback
```

Guarde Client ID em `GOOGLE_OAUTH_ID` e Client secret no cofre para `GOOGLE_OAUTH_SECRET`. O login usa `openid email profile`. O callback HTTP é da API; não cadastre `nexus://auth` como callback Google. Confira a igualdade completa do URI, inclusive ausência de barra final. Fonte: [Google OAuth Web Server][google-oauth].

No GitHub: Settings > Developer settings > OAuth Apps > New OAuth App. Homepage URL: `https://nexuside.app`. Authorization callback URL:

```text
https://api.nexuside.app/v1/auth/github/callback
```

Guarde Client ID em `GITHUB_OAUTH_ID` e o Client secret no cofre para `GITHUB_OAUTH_SECRET`. A API pede `read:user user:email`. Confira o callback salvo e o e-mail primário verificado da conta de teste. Use OAuth App, conforme a implementação atual. Fonte: [criação de OAuth App][github-oauth].

Conferência funcional dos dois provedores ocorre em 2.9. Não remova callbacks antigos necessários a um serviço ainda em operação.

### 2.5 Criar o Product, Price e Customer Portal de teste

**Caminho recomendado:** com a chave de teste no ambiente, rode o script idempotente do repositório. Ele cria ou reaproveita o produto, o preço mensal de R$ 59,99, atualiza o Customer Portal padrão e cria o webhook da etapa 2.7 com os seis eventos, imprimindo os IDs e os comandos `wrangler` seguintes. Rodar de novo não duplica nada; `--dry-run` só mostra o plano; chave live exige `--live`.

```sh
STRIPE_SECRET_KEY='<sk_test_...>' npm run stripe:provision -- --json
```

As instruções manuais abaixo continuam válidas para conferência ou para quem preferir o painel.

No Stripe, selecione explicitamente o ambiente de teste do produto. Todos os objetos e a chave desta etapa pertencem a esse mesmo ambiente. Em Product catalog > Add product, crie Nexus Pro com preço fixo recorrente mensal, BRL, R$ 59,99, quantidade 1. Guarde `<PRICE_ID_TESTE>` em `STRIPE_PRICE_PRO`. Não adicione trial do Stripe: os 15 dias do Nexus começam no login, sem cartão. O checkout atual cobra a assinatura imediatamente. Fonte: [Products e Prices][stripe-prices].

Como alternativa ao painel, existe este comando no repositório do app, já inspecionado em `main`:

```sh
cd /Users/cleofasrocha/dev/nexus-ide/server
npm run stripe:provision
cd /Users/cleofasrocha/dev/nexus-cloud-api
```

Use-o somente com `STRIPE_SECRET_KEY` de teste já carregada pelo cofre no ambiente desse processo e dependências do server disponíveis. Ele altera o catálogo Stripe. Cria/reutiliza `NexusIDE Pro` e o Price mensal correto, define o preço padrão e imprime o ID. Não rode painel e script como duas etapas obrigatórias. O script não tem modo dry-run e não cria webhook nem portal. Sua busca cobre os primeiros 100 Products/Prices; em catálogo maior, confira o painel antes de repetir.

Para conferir o Price pelo CLI, autentique o CLI no mesmo ambiente. Garanta que não exista override `STRIPE_API_KEY` de outra conta ou live. Não passe segredo como argumento:

```sh
stripe login
stripe prices retrieve <PRICE_ID_TESTE>
```

Esperado: `livemode=false`, `active=true`, `currency=brl`, `unit_amount=5999`, `type=recurring`, `recurring.interval=month`, `interval_count=1`. O ID tem de ser exatamente o configurado no Worker. Fontes: [login][stripe-login], [credenciais CLI][stripe-cli-keys], [comandos de recursos][stripe-resources], [Price retrieve][stripe-price-get] e `server/scripts/provision-stripe.ts`.

Em Settings > Billing > Customer portal, ainda em teste, habilite atualização do meio de pagamento, histórico de faturas e cancelamento no fim do período. Desabilite troca de plano, quantidade e promoções não aprovadas. Retorno: `https://nexuside.app/conta/`. Não configure domínio customizado do Stripe: o site aceita `checkout.stripe.com` e `billing.stripe.com`. Salve e confira abrindo **Gerenciar assinatura** após a compra. Fonte: [configuração do portal][stripe-portal].

### 2.6 Configurar variáveis e fazer o primeiro deploy fechado

Confira as 20 variáveis de `src/config.ts`:

| Variável | Configuração nesta etapa | Conferência |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://api.nexuside.app` | Callback e emissor da licença |
| `PUBLIC_SITE_URL` | `https://nexuside.app` | Origem CORS e retorno ao site |
| `APP_DEEP_LINK_BASE` | `nexus://auth` | Retorno do login nativo do NexusIDE |
| `SHOT_DEEP_LINK_BASE` | `nexus-shot://auth/callback` | Retorno do login nativo do Nexus Shot (`client=shot`); tem default no parser, mas confira o valor antes de publicar |
| `APP_MODE` | `staging` | Não é isolamento Stripe |
| `MIGRATION_READY` | `false` | `/v1/public/status` tem `ready=false` |
| `ADMIN_EMAILS` | `<EMAIL_ADMIN_1>,<EMAIL_ADMIN_2>` | Os dois endereços de 1.1, sem outros usuários |
| `TRIAL_DAYS` | `15` | `trial.days=15` |
| `TRIAL_MAX_AGENTS` | `2` | `trial.maxAgents=2` |
| `TRIAL_CLOUD_SYNC` | `false` | `trial.cloudSync=false` |
| `GOOGLE_OAUTH_ID`, `GITHUB_OAUTH_ID` | `<CLIENT_ID_GOOGLE>`, `<CLIENT_ID_GITHUB>` | Clientes de 2.4 |
| `STRIPE_PRICE_PRO` | `<PRICE_ID_TESTE>` | Price validado em 2.5 |
| `STRIPE_PRICE_TEAM` | String vazia | Não vender Team nem cadastrar preço legado sem necessidade |
| `LICENSE_PRIVATE_KEY`, `LICENSE_PUBLIC_KEY` | Secrets PEM de 2.3 | Par correto |
| `STRIPE_SECRET_KEY` | Secret de teste | Mesmo ambiente do Price |
| `STRIPE_WEBHOOK_SECRET` | Secret do destino de teste de 2.7 | Não confundir com o secret de `stripe listen` |
| `GOOGLE_OAUTH_SECRET`, `GITHUB_OAUTH_SECRET` | Secrets de 2.4 | Correspondem aos Client IDs |

As variáveis não secretas ficam em `vars` no `wrangler.jsonc`. Preserve `DB`, `AUTH_RATE_LIMITER` e `API_RATE_LIMITER`. Preserve `main`, `nodejs_compat` e a data de compatibilidade. Não há `DATABASE_URL`, chave publishable Stripe ou segredo de cron a acrescentar: o código usa binding D1 e checkout hospedado.

Confira o `wrangler.jsonc`: `workers_dev` e `preview_urls` já estão `false` e a rota `custom_domain` já existe, então a entrada é só pelo domínio. Preserve esse bloco, o cron e a observabilidade, e comprove no ambiente publicado que não há entrada alternativa:

```jsonc
"routes": [{ "pattern": "api.nexuside.app", "custom_domain": true }],
"workers_dev": false,
"preview_urls": false,
"triggers": { "crons": ["17 * * * *"] },
"observability": { "enabled": true }
```

Desabilitar os endereços alternativos evita contornar a restrição temporária de acesso do ensaio. Confira também as URLs de versões antigas em Domains & Routes. Fontes: [workers.dev][w-workersdev] e [Version URLs][w-previews].

**Restrinja o ensaio antes de publicar login.** A flag de migração não bloqueia cadastro nem início de trial. Na Cloudflare, zona `nexuside.app` > Security > WAF/Custom rules > Create rule, use o construtor para bloquear o host `api.nexuside.app` quando o IP de origem estiver fora da lista do operador, exceto o caminho exato `/v1/billing/webhook`. Inclua os IPv4/IPv6 de saída do navegador e do app. Não aplique challenge ao webhook. Após o deploy, confira de outra rede que o login fica bloqueado, enquanto a rede autorizada consegue usá-lo. Mantenha essa restrição até 3.4. Fonte: [custom rules][w-waf].

Rate limits em vigor no código: `AUTH_RATE_LIMITER` (namespace 2001) permite 20 requisições por 60 s em `/v1/auth/*` e `/v1/web/auth/*`; `API_RATE_LIMITER` (namespace 2002) permite 120 por 60 s nos demais `/v1/*` e em `/ready`; a chave é `CF-Connecting-IP` (fallback `unknown`) e a recusa é 429. `/health` não passa pelo limiter e `/v1/billing/webhook` é excluído. Não troque os dois bindings entre si nem aplique throttling adicional ao webhook.

```sh
cd /Users/cleofasrocha/dev/nexus-cloud-api
wrangler deploy --dry-run
wrangler deploy
wrangler secret put LICENSE_PRIVATE_KEY < '<DIR_PRIVADO>/license-private.pem'
wrangler secret put LICENSE_PUBLIC_KEY < '<DIR_PRIVADO>/license-public.pem'
wrangler secret put GOOGLE_OAUTH_SECRET
wrangler secret put GITHUB_OAUTH_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret list
```

Nos comandos interativos, cole somente o segredo solicitado. Nunca digite `echo <segredo>` no shell. PEMs precisam de quebras de linha reais. `secret put` publica uma nova versão imediatamente. `MIGRATION_READY=false` fecha novos checkouts; login só fica indisponível se as credenciais OAuth ou as chaves de licença estiverem ausentes — a flag não impede login, webhook nem portal. Não infira ausência de secrets a partir de um primeiro deploy deste roteiro: confira com `secret list`. Confira os cinco nomes cadastrados, sem imprimir valores. O sexto será cadastrado em 2.7. Fontes: [Wrangler Workers][w-workers], [secrets][w-secrets].

O deploy cria o Custom Domain declarado. Confira em Workers & Pages > `nexus-cloud-api` > Settings > Domains & Routes. A alternativa manual é Add > Custom Domain > `api.nexuside.app`. A Cloudflare gerencia DNS e certificado. Se já existir um CNAME nesse hostname, pare e registre seu destino antes de planejar a substituição; não apague registros às cegas. Fonte: [Custom Domains][w-domains].

```sh
curl --fail --silent --show-error https://api.nexuside.app/health
curl --fail --silent --show-error https://api.nexuside.app/ready
curl --fail --silent --show-error https://api.nexuside.app/v1/public/status
```

Conferência: TLS válido; `/health` e `/ready` com `ok=true`; `ready=false` no status público. Antes do webhook, `billing.available` pode ser falso. `/ready` só testa leitura do banco; `/health` só prova que o Worker atende. Nenhum deles prova OAuth, preço ou licença. Não use `curl -k`. Sintaxe das conferências HTTP: [curl][curl].

Em Settings > Trigger Events > Cron Triggers, confira `17 * * * *`. Significa minuto 17 de cada hora em UTC. Aguarde até 15 minutos para propagação e confira uma execução em Logs. A cada hora, no minuto 17 UTC, `scheduled` executa `cleanupExpired`: remove `oauth_states`, `auth_codes`, `sessions` e `refresh_tokens` vencidos e `cron_leases` vencidos há mais de uma hora. Ele não executa as tarefas de usuário, não cobra, não renova licenças e não substitui webhook.

Não confunda esse gatilho com a API nativa de cron do app, que continua no Worker: `GET /v1/cron/projects/:projectId/schedules`, `PUT /v1/cron/projects/:projectId/schedules/:scheduleId` e `POST /v1/cron/leases/{acquire,renew,release}`, todas com Bearer desktop. Publicar, adquirir e renovar exigem acesso `trial` ou `pro`, não sync pago. Não existe segredo de cron nem endpoint HTTP público que substitua o `scheduled`. Não existe um comando obrigatório `wrangler cron`: `deploy` aplica `triggers.crons`. Fonte: [Cron Triggers][w-cron].

### 2.7 Cadastrar o webhook de teste

Se você rodou `npm run stripe:provision` na etapa 2.5, o destino já existe: use o `webhookSecret` da saída `--json` em `wrangler secret put STRIPE_WEBHOOK_SECRET` e pule para a conferência. Sem assinatura, o endpoint responde 400 antes de qualquer verificação de configuração.

No Stripe, ainda no mesmo ambiente de teste: Workbench > Webhooks > criar destino. Escolha eventos da própria conta, payload de eventos compatível com o endpoint clássico, destino HTTPS:

```text
https://api.nexuside.app/v1/billing/webhook
```

Selecione exatamente:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

Esses seis eventos são a seleção operacional; no código o roteador reconhece `checkout.session.completed` e os prefixos `customer.subscription.*` e `invoice.*` (inclusive `invoice.parent.subscription_details.subscription`). A assinatura é verificada sobre o corpo original com o header `stripe-signature` e `STRIPE_WEBHOOK_SECRET` (`constructEventAsync`/SubtleCrypto): na conferência de 2.10, teste também assinatura adulterada e fora da tolerância de tempo, não só header ausente. Evento ignorado também recebe `processed_at` e 200: inspecione `payload.ignored` (razões `foreign-price`, `missing-owner`, `unknown-owner`, `customer-mismatch`, `missing-period`) e reconcilie com o Stripe; "sem pendentes" não prova concessão. Falha transitória ao consultar o Stripe deixa o evento sem `processed_at` para o retry do Stripe.

Anote a versão da API do destino e a do SDK da aplicação. Não selecione thin events para este handler. Copie o signing secret desse destino para o prompt:

```sh
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret list
curl --fail --silent --show-error https://api.nexuside.app/v1/public/status
curl --include --silent --show-error --request POST https://api.nexuside.app/v1/billing/webhook --header 'Content-Type: application/json' --data '{}'
```

Conferência: seis secrets presentes; `billing.available=true`, `auth.google=true`, `auth.github=true`, `ready=false`. POST sem assinatura deve retornar 400, sem novo registro em `stripe_events`. Presença de configuração não prova validade da credencial. A entrega real de 2.10 deve retornar 2xx. Fonte: [webhooks Stripe][stripe-webhooks].

### 2.8 Publicar as telas fechadas e decidir como ensaiar o checkout

Primeiro integre a Fase 3 de `nexus-site/docs/plano-comunidade-planos-assinatura.md`. Confira `vite.config.js` com as entradas de `conta/` e `admin/`, `worker/index.js` com suas rotas e CSP permitindo conexão à API. Se faltarem, não prossiga: este documento não implementa as telas.

```sh
cd /Users/cleofasrocha/dev/nexus-site
npm ci
npm test
npm run build
wrangler deploy --dry-run
wrangler deploy
curl --include --silent --show-error https://nexuside.app/conta/
curl --include --silent --show-error https://nexuside.app/admin/
cd /Users/cleofasrocha/dev/nexus-cloud-api
```

Conferência: build inclui as duas páginas; ambas atendem sem 404; planos e conta informam contratação indisponível com `ready=false`. Confira no navegador que não há erro CORS/CSP. Esse deploy permite validar login, sem abrir vendas. Scripts: `nexus-site/package.json`; deploy: [Wrangler][w-workers].

**Decisão pendente antes de 2.10:** o código recusa checkout com `MIGRATION_READY=false`, inclusive com chave de teste. A regra vigente é manter a flag falsa até o operador abrir as vendas. Portanto, não existe ensaio completo de checkout nesse Worker fechado. Não declare que passou. O operador precisa autorizar uma janela de contratação exclusivamente de teste ou preparar homologação separada. Sem essa decisão, faça 2.9 e os testes automatizados e marque 2.10 em diante como não confirmado. Este roteiro não concede essa exceção.

Se o operador autorizar a janela de teste no domínio final, mantenha a restrição temporária aplicada em 2.6. Confira que a lista de IPs continua correta e cobre também a rede do app.

Conferência obrigatória: de outra rede, `/v1/web/auth/google` fica bloqueado; na rede autorizada, OAuth funciona; POST sem assinatura no webhook continua chegando à API e retorna 400; `workers.dev` e Version URLs não dão acesso alternativo. Sem essa prova, não abra a flag. O bloqueio também impede que outros usuários comecem testes descartáveis no banco de ensaio.

Somente dentro dessa janela autorizada, com D1 de teste e chave de teste conferidos, altere `MIGRATION_READY` para `true` e execute `wrangler deploy`. Confira `ready=true`. Isso abre contratação no ambiente de teste; não é um modo especial do código. Ao concluir o ensaio, volte a `false`, publique e confira. Não deixe a alteração aberta por padrão.

### 2.9 Validar login e início do teste

Abra DevTools > Network no navegador para conferir respostas. Não exporte cookies, HAR com credenciais, CSRF ou tokens para o registro da operação.

Checklist de segurança web: os quatro cookies `__Host-nexus_session`, `__Host-nexus_refresh`, `__Host-nexus_csrf` e `__Host-nexus_oauth_state` chegam com `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` e sem `Domain`. O `csrfToken` vem do JSON de `GET /v1/web/session`, nunca de `document.cookie`. Toda mutação web (checkout, portal, logout, admin) exige `Origin` exatamente igual à origem de `PUBLIC_SITE_URL` e `X-CSRF-Token` válido: teste ausência, adulteração e origem estrangeira, esperando 403. O CORS só concede credenciais a essa origem; isso não bloqueia clientes HTTP em geral nem substitui a WAF.

Autoridade administrativa: exige `accounts.role=admin` **e** identidade do provedor com `email_verified=1` cujo e-mail, normalizado, esteja em `ADMIN_EMAILS`. Editar só o `role` ou ter um e-mail igual em texto não basta; sair da lista ou perder a verificação derruba a autoridade, e um admin não pode suspender a própria conta. Rotas: `GET /v1/admin/overview`, `GET /v1/admin/accounts` e `POST /v1/admin/accounts/:id/{suspend,resume,extend-trial}`.

| Passo | Ação | Resultado esperado |
| --- | --- | --- |
| Google | Em janela privada, `/conta/` > entrar com Google usando conta comum nova | Consentimento no Google, retorno à API e depois ao site; `GET /v1/web/session` com `authenticated=true`, `profile.role=user`, `entitlement.access=trial`. |
| GitHub | Saia. Em outra janela privada, entre pelo GitHub com segunda conta comum | Mesmo fluxo; identidade GitHub verificada; sessão de usuário comum. |
| Identidade | Se testar os dois provedores com o mesmo e-mail verificado | A API pode vincular ambos à mesma conta. Isso não é nova conta nem novo teste. |
| Duração | Consulte a sessão e o SQL abaixo | `trialEndsAt` 15 dias após a criação, `maxAgents=2`, `cloudSync=false`. Novo login não reinicia o prazo. |
| Admin | Entre em outra janela com um dos administradores de 1.1 e abra `/admin/` | `profile.role=admin`, lista e resumo acessíveis. Repetir com o segundo administrador. |
| Isolamento | Com conta comum, abra `/admin/` e confira a requisição à API | API responde 403. Ocultar a tela sem bloquear a API não passa. |
| Checkout fechado | Com a flag falsa e usuário comum, conferir chamada autenticada de checkout | 503. O botão fica desabilitado. Uma chamada sem sessão daria 401 e não provaria a flag. |

```sh
wrangler d1 execute DB --remote --command "SELECT id,role,(trial_expires_at-trial_started_at)/86400000.0 AS dias,datetime(trial_expires_at/1000,'unixepoch') AS termina_utc FROM accounts ORDER BY created_at DESC LIMIT 10;"
```

Esperado: contas comuns novas com `dias=15`. Admin tem acesso Pro administrativo e não prova assinatura.

Para conferir a recusa do checkout sem expor tokens, no console de **`https://nexuside.app/conta/`**, apenas enquanto `ready=false`:

```js
const session = await fetch('https://api.nexuside.app/v1/web/session', { credentials: 'include' }).then(r => r.json());
const response = await fetch('https://api.nexuside.app/v1/web/checkout', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken },
  body: JSON.stringify({ plan: 'pro', attemptId: crypto.randomUUID() })
});
console.log(response.status);
```

Esperado: `503`. Esse comando cria checkout se executado com a flag aberta; não o reutilize inadvertidamente na fase live. Contrato: `src/auth.ts`, `src/accounts.ts`, `src/access.ts`, `src/billing.ts` e seus testes.

### 2.10 Validar checkout, webhook e Pro

Execute somente após a decisão de 2.8. No Stripe, confirme novamente o indicador de teste. Use uma conta comum sem assinatura ativa.

1. Em `/conta/`, escolha Pro. Confira no Checkout o ambiente de teste, BRL e R$ 59,99 por mês. O código não dá mais 15 dias de trial Stripe nesta compra.
2. Use o cartão de teste `4242 4242 4242 4242`, validade futura e CVC fictício de três dígitos. Não use cartão real. Conclua o checkout. Fonte: [cartões de teste][stripe-testing].
3. No Workbench > Webhooks > destino de teste > entregas, confira `checkout.session.completed`, criação/atualização da assinatura e `invoice.paid` com 2xx. Registre somente IDs de evento e assinatura e horário. A ordem de entrega pode variar.
4. Abra a assinatura no Stripe. Confira Price correto e `metadata.accountId` igual ao ID da conta D1. `metadata.plan` deve ser `pro`. Confira o SQL abaixo.
5. Atualize `/conta/`. Em `/v1/web/session`, espere `entitlement.access=pro`, `status=active`, `cloudSync=true`, `maxAgents=null`. A URL `?checkout=success` sozinha não libera nada. Digitar essa URL para outra conta não muda seu acesso.
6. Clique Gerenciar assinatura. Espere portal em `billing.stripe.com`, assinatura correta e retorno à `/conta/`. Novo checkout para uma assinatura já ativa deve ser recusado com 409.
7. Reenvie **o mesmo evento real** pela tela de entregas do webhook. Espere 2xx e nenhuma assinatura duplicada. Não crie uma segunda compra para testar repetição.

```sh
wrangler d1 execute DB --remote --command "SELECT event_id,type,processed_at FROM stripe_events ORDER BY created_at DESC LIMIT 20;"
wrangler d1 execute DB --remote --command "SELECT stripe_subscription_id,account_id,plan,status,current_period_end,grace_until FROM subscriptions ORDER BY updated_at DESC LIMIT 10;"
```

Conferência: eventos relevantes com `processed_at` preenchido; uma assinatura correspondente em `active`. O webhook consulta a assinatura atual na API Stripe. Um evento antigo não deve rebaixar estado mais recente. Fontes: implementação `src/billing.ts` e [entrega de webhooks][stripe-webhooks].

### 2.11 Provar a licença no app instalado

No app instalado, entre com a mesma conta comum que comprou em 2.10. Repita login nativo com Google e GitHub. O navegador deve retornar por `nexus://auth`; a API faz exchange com PKCE.

**Nexus Shot instalado.** Repita o login pelo Shot: ele inicia `/v1/auth/google` ou `/v1/auth/github` com `app_state`, `code_challenge` e `client=shot`; o navegador deve voltar por `nexus-shot://auth/callback/<code>?state=<app_state>` e o Shot troca o código em `POST /v1/auth/exchange` com o `code_verifier`. Sem `client` (ou com `client=nexus`) o retorno continua `nexus://auth/<code>?state=…`. `client` desconhecido ou duplicado, e qualquer `client` no início web, respondem 400. O callback usa o cliente salvo em D1, nunca o recebido no retorno. Os callbacks OAuth do Google/GitHub continuam HTTPS na API: não cadastre o esquema `nexus-shot` no provedor. A licença continua `aud=nexus-desktop`; a compatibilidade do Shot com ela precisa ser provada no app, não presumida. O destino padrão é `https://api.nexuside.app`. Confira que não existe override de `NEXUS_BACKEND_URL` apontando para a Railway ou outro serviço.

Depois de comprar no site, faça sair/entrar explicitamente no app para obter uma licença nova. Não dependa de reiniciar o app: o código atual pode evitar sync no boot sem sessão já desbloqueada. A licença de trial também usa `plan=pro`, por isso o rótulo “Pro” isolado não prova pagamento.

Conferência: assinatura aceita pela pública efetiva do instalador, conta correta e token novo com `access=pro`, `limits.cloudSync=true`, `limits.maxAgents=null`, `aud=nexus-desktop`, `iss=https://api.nexuside.app`, `sub` da conta e `exp` futuro. Confira apenas claims selecionadas em diagnóstico local, sem imprimir/copiar o JWT inteiro. Compare com o trial anterior: `access=trial`, limite 2 e sync falso.

O app grava o token em `~/.nexus/license.json`. No terminal comum do mesmo usuário, confira o arquivo produzido pelo login. Use a pública efetiva obtida em 2.3 e o ID da conta observado em 2.10:

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { verify } from 'node:crypto';
const stored = JSON.parse(readFileSync(join(homedir(), '.nexus', 'license.json'), 'utf8'));
const parts = typeof stored.token === 'string' ? stored.token.split('.') : [];
if (parts.length !== 3) throw new Error('Token ausente ou inválido');
const [header, payload, signature] = parts;
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const publicKey = readFileSync('<DIR_PRIVADO>/app-license-public.pem');
if (decode(header).alg !== 'EdDSA' || !verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('Assinatura inválida');
const claims = decode(payload);
if (claims.iss !== 'https://api.nexuside.app' || claims.aud !== 'nexus-desktop' || claims.sub !== '<ACCOUNT_ID_TESTE>' || typeof claims.exp !== 'number' || claims.exp <= Date.now()/1000) throw new Error('Identidade, destino ou validade incorretos');
console.log({ assinaturaValida: true, access: claims.access, plan: claims.plan, status: claims.status, limits: claims.limits, validadeAte: new Date(claims.exp*1000).toISOString() });
NODE
```

Esperado após compra: `assinaturaValida=true`, `access=pro` e os limites de Pro. Este diagnóstico não edita o arquivo nem injeta licença. Ele valida o token local; a tela e os bloqueios do app ainda precisam de observação. Fonte: [Node crypto][node-crypto] e caminho persistido em `billing-ipc.ts`.

**Não confirmado:** um instalador disponível já conter essa pública e aplicar `access`/`limits`. Em `main`, `billing-ipc.ts` persiste principalmente plano/status e não prova os bloqueios novos. Se o app só mostrar Pro, marque a prova de limites como pendente. Não anuncie enforcement que não foi observado. Veja 6.1.

### 2.12 Falha de pagamento, graça, recuperação e cancelamento

Use a assinatura de teste real criada pelo checkout. Não use `stripe trigger invoice.payment_failed` como prova de inadimplência dessa conta.

**Falha de renovação.** No portal, cadastre o cartão de teste `4000 0000 0000 0341` e torne-o o meio de pagamento usado pela assinatura. Ele permite cadastro e falha na cobrança. Confira o método na própria assinatura, pois um default da assinatura pode prevalecer sobre o default do Customer. Fonte: [Stripe testing][stripe-testing].

No Dashboard de teste > Billing > Subscriptions > assinatura > **Run simulation**, avance além da renovação e da finalização da fatura. Aguarde a simulação terminar. Confira que os IDs da assinatura e `metadata.accountId` enviados ao webhook são os ligados à conta de ensaio. Se a simulação criar objetos diferentes ou o botão estiver indisponível, esse caminho fica **não confirmado** na conta: não atribua o resultado à compra original. Confira elegibilidade no [guia de simulações][stripe-simulate].

Alternativa sem simulação: no painel da assinatura de teste, Actions > Update subscription > Add free trial, acrescente um trial curto apenas para provocar a próxima cobrança com o cartão de falha. Aguarde seu fim e a tentativa da fatura, que pode levar cerca de uma hora depois de gerada. Esse trial Stripe é uma ferramenta de ensaio; não altera a política de 15 dias do Nexus. Fonte: [teste de Billing][stripe-billing-testing].

Conferência após a cobrança: assinatura Stripe em `past_due`, evento `invoice.payment_failed` entregue e D1 com `status=past_due`. A primeira observação desse estado fixa `grace_until` em aproximadamente agora + 7 dias. `/conta/` continua com `access=pro`, mas `status=past_due`.

```sh
wrangler d1 execute DB --remote --command "SELECT stripe_subscription_id,status,datetime(grace_until/1000,'unixepoch') AS graca_ate_utc,(grace_until-updated_at)/86400000.0 AS dias_desde_ultima_atualizacao FROM subscriptions WHERE stripe_subscription_id='<SUB_ID_TESTE>';"
```

Registre `grace_until`. Reenvie o mesmo evento e provoque outra tentativa de pagamento pela fatura de teste. Confira que `grace_until` não aumentou. A coluna calculada pode deixar de ser 7 após outras atualizações; o prazo absoluto deve permanecer igual. Se a política de recuperação Stripe cancelar ou marcar `unpaid` antes dos sete dias, o código já retira o acesso pago. Ajuste a política do ambiente de ensaio para manter `past_due` durante esta prova. Não confunda o prazo do Nexus com a agenda de tentativas do Stripe.

**Fim da graça.** Test Clock altera o tempo do Stripe, não `Date.now()` do Worker nem os prazos D1. Para prova manual sem alterar dados, espere o `grace_until` UTC e use uma conta cujo trial Nexus também tenha acabado. Atualize a sessão. Resultado: `access=inactive`, `maxAgents=0`, `cloudSync=false`. Se o trial Nexus ainda estiver válido, o resultado correto é `access=trial`.

Para acelerar somente essa conferência existe o procedimento do Apêndice A, que adultera datas diretamente no banco e por isso fica fora do caminho normal: só em base descartável ou local, nunca no banco que será promovido.

Sem o apêndice, aguarde os prazos reais: os testes automatizados já cobrem a duração e a ancoragem sem adulterar banco. O app instalado ainda precisa provar o bloqueio.

**Recuperação.** Troque no portal para o cartão de sucesso. Na fatura de teste em aberto, acione nova tentativa de pagamento. Espere `invoice.paid` com 2xx, assinatura `active`, `grace_until=NULL` e `access=pro` de novo. Confira pelas consultas de 2.10. Não considere só o botão do portal como prova.

**Cancelamento.** No portal, solicite cancelar no fim do período. Confira no Stripe `cancel_at_period_end=true` e data final; o acesso Pro continua até essa data. Na simulação, avance até o cancelamento efetivo. Espere `customer.subscription.deleted`, D1 `canceled` e retirada do direito pago. Trial Nexus restante pode dar acesso `trial`; trial vencido resulta em `inactive`. Para testar retirada imediata separadamente, cancele uma assinatura fictícia pelo Dashboard de teste e confira os mesmos resultados. **Em live, cancelar imediatamente encerra a assinatura real e não pode ser desfeito por “Restaurar acesso” no Nexus.** Fonte: [cancelamento Stripe][stripe-cancel].

### 2.13 Suspender, restaurar e estender o teste

Mantenha duas janelas: administrador em `/admin/` e usuário comum em `/conta/`.

| Ação no painel | Conferência na API, conta e app |
| --- | --- |
| Suspender conta com motivo fictício identificável | POST `/v1/admin/accounts/<ID>/suspend` com 200. Sessão do usuário passa a `access=suspended`, limite 0 e sync falso. Com billing configurado, sessão/CSRF/corpo válidos e `MIGRATION_READY=true`, o checkout retorna 403; com a flag falsa, retorna 503 antes de avaliar a suspensão — registre em qual estado a flag estava. Renove a licença no app e verifique bloqueio. |
| Abrir portal da conta suspensa | Portal continua disponível. Confira que a assinatura Stripe não foi cancelada. **Suspender não interrompe cobrança.** |
| Restaurar acesso | POST `/resume` com 200. A API recalcula: Pro se houver direito pago, trial se vigente, inactive se vencido. Restaurar não recria assinatura nem reinicia teste. |
| Estender teste de conta comum sem assinatura ativa | Acrescente 1 dia. POST `/extend-trial` com 200. Para conta comum não suspensa e sem direito pago pessoal ou de time, novo fim = max(agora, fim anterior) + 1 dia e ela passa a `trial` (limite 2, sem sync). A extensão não remove suspensão nem reduz direito pago. Não há cobrança Stripe. |
| Repetir com usuário comum tentando ação admin | 403 e nenhuma alteração/auditoria bem-sucedida. Admin não pode suspender a própria conta. |

```sh
wrangler d1 execute DB --remote --command "SELECT action,target_account_id,datetime(created_at/1000,'unixepoch') AS quando_utc FROM admin_audit ORDER BY created_at DESC LIMIT 10;"
```

Esperado: ações `suspend`, `resume`, `extend_trial`, ligadas ao alvo correto. Não registre motivo com dados sensíveis. Extensão aceita 1 a 30 dias e é cumulativa; clicar de novo acrescenta mais dias. Não existe botão de desfazer extensão. Fonte: `src/admin.ts`, `src/access.ts` e `tests/admin.test.ts`.

### 2.14 Stripe CLI local, diagnóstico complementar

Este diagnóstico não substitui a compra real de teste de 2.10. Use D1 local, nunca `wrangler dev --remote`. Em `.dev.vars` privado e ignorado pelo Git, configure os secrets de teste. O secret local do webhook será o emitido por `listen`; mantenha o secret do Dashboard no Worker remoto.

```sh
cd /Users/cleofasrocha/dev/nexus-cloud-api
wrangler d1 migrations apply DB --local
stripe login
stripe listen --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed --forward-to http://localhost:8787/v1/billing/webhook
```

Deixe `listen` aberto. Copie seu signing secret para `STRIPE_WEBHOOK_SECRET` somente no `.dev.vars`. Em outro terminal, execute `wrangler dev`. Em um terceiro terminal:

```sh
stripe trigger checkout.session.completed
stripe trigger invoice.payment_failed
```

Conferência: o CLI recebe e encaminha eventos; veja o HTTP retornado pelo Worker local. `trigger` cria objetos fictícios Stripe, inclusive eventos adicionais. Eles podem não ter Price aprovado, `metadata.accountId` ou assinatura vinculada ao D1. Um 200 de evento sem assinatura associada não prova Pro; uma recusa de objeto sem dono não é falha do checkout real. Para provar direito pago, use os objetos de 2.10. Fontes: [listen][stripe-listen], [trigger][stripe-trigger], [Billing testing][stripe-billing-testing].

### 2.15 Encerrar o ensaio

Volte `MIGRATION_READY` para `false` no arquivo e publique. Confira o status público e o 503 autenticado de 2.9. Preserve o D1 de teste e o registro dos resultados. Cancele assinaturas fictícias no Stripe de teste e espere suas entregas antes de desabilitar o destino de teste. Não use “Finish simulation” se precisar preservar os objetos da simulação: essa ação os apaga. Confira pendências de webhook antes de encerrar.

Conferência: nenhuma contratação nova disponível, nenhum objeto live alterado e todos os itens de 2.9 a 2.13 registrados como passou, falhou ou não confirmado. Qualquer prova pendente impede declarar o fluxo completo validado.

## 3. Virada para produção

### 3.1 Preparar a base live preservando o ensaio

Mantenha checkout fechado e restrição temporária de acesso. Confirme ausência de usuários reais no banco que será deixado para trás. Se houver, interrompa a troca: é necessária migração/reconciliação, fora deste roteiro.

Configure `DB` com nome e UUID do banco de produção escolhido em 2.1. Aplique as quatro migrations pelo ledger e confira a base antes de publicar (a mesma conferência de 2.2, inclusive os `PRAGMA table_info`), e confira que `SHOT_DEEP_LINK_BASE` está em `vars`:

```sh
wrangler d1 migrations list DB --remote
wrangler d1 migrations apply DB --remote
wrangler d1 execute DB --remote --command "SELECT value FROM system_metadata WHERE key='schema_version'; SELECT count(*) AS contas FROM accounts; SELECT count(*) AS assinaturas FROM subscriptions; SELECT count(*) AS eventos FROM stripe_events;"
```

Esperado: versão 4 e base reservada vazia, sem clientes/assinaturas de teste. Configure `APP_MODE=production` e mantenha `MIGRATION_READY=false`. Não copie tabelas `accounts`/`subscriptions` do ensaio para live. Os administradores serão reconhecidos no novo login. O mesmo par Ed25519 continua valendo.

### 3.2 Preparar Stripe live e substituir o conjunto inteiro

**Esta etapa configura dinheiro real.** No Stripe, conclua ativação da conta e confira recebimentos, dados comerciais, suporte e descritor. Selecione live. Na conta live já existe o produto NexusIDE Pro com preço mensal de R$ 59,99; o script `stripe:provision` reconhece esse produto do catálogo antigo (metadata `nexusProduct=nexuside_pro`) e não cria outro. Criar catálogo não cobra por si; checkout e renovações live cobram. Fonte: [checklist live][stripe-live].

Confirme o Price live com uma chamada somente de leitura:

```sh
stripe prices retrieve <PRICE_ID_LIVE> --live
```

Espere `livemode=true` e os mesmos BRL/5999/mês/interval_count 1. Configure o portal **também em live**. Não assuma que configurações do modo de teste foram copiadas.

Crie um **novo destino de webhook live**, na URL de 2.7, com os mesmos seis eventos. O webhook de produção que já existe aponta para o host antigo `https://nexuside.app/v1/billing/webhook`; a API nova precisa do destino em `https://api.nexuside.app/v1/billing/webhook`. Também não há configuração padrão do Customer Portal em live: configure-a nesta etapa. Guarde seu novo signing secret. Desabilite o destino de teste somente depois de suas entregas finais. A API tem um único `STRIPE_WEBHOOK_SECRET`; não recebe os dois modos ao mesmo tempo.

Com vendas fechadas, cadastre o par Stripe live:

```sh
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

Preencha `STRIPE_PRICE_PRO=<PRICE_ID_LIVE>` no arquivo. Confira D1 live, pública da licença, Client IDs e URLs. Publique o conjunto final:

```sh
wrangler deploy --dry-run
wrangler deploy
wrangler secret list
curl --fail --silent --show-error https://api.nexuside.app/ready
curl --fail --silent --show-error https://api.nexuside.app/v1/public/status
```

Espere banco pronto, `ready=false`, autenticação e billing disponíveis. Os `secret put` publicam versões intermediárias. Não faça essa sequência com vendas abertas ou assinaturas reais em atendimento. Para futura rotação sem interrupção, prepare uma mudança própria e coordenada. Não volte credenciais de teste sobre D1 live.

**Atalho (01/10/2026):** `scripts/go-live-stripe.sh` faz 3.1 e 3.2 em ordem, com as vendas fechadas: fecha a venda, provisiona o Stripe live (recusa mexer num Customer Portal padrão que não seja do Nexus, porque a conta live é compartilhada), grava os dois segredos por pipe, troca o D1 para `nexus-cloud-prod`, `APP_MODE=production` e o Price live, e confere `/health`, `/ready` e o status. A chave live restrita do Nexus (seis permissões de escrita: Customers, Products, Checkout Sessions, Customer portal, Subscriptions, Webhook endpoints) é criada no painel e lida da área de transferência. `scripts/go-live-stripe.sh --abrir-vendas` é a cobrança real (3.4) e só roda depois da conferência.

### 3.3 Conferir OAuth público e site antes de abrir

No Google Auth Platform, confira Audience/publicação para usuários reais e eventuais exigências de verificação exibidas no projeto. A aprovação efetiva desse cliente está **não confirmada** até conferência no painel e login com uma conta fora da lista de teste. No GitHub, confira novamente o callback final. Repita login com os dois provedores e acesso admin na nova base.

Publique a versão revisada do site com planos, conta e administração. Ainda com `ready=false`:

```sh
cd /Users/cleofasrocha/dev/nexus-site
npm test
npm run build
wrangler deploy --dry-run
wrangler deploy
cd /Users/cleofasrocha/dev/nexus-cloud-api
```

Conferência no navegador: `/`, `/conta/` e `/admin/` funcionam; público não lê dados admin; preço e trial refletem a API; contratação continua desabilitada. A comunidade e downloads continuam atendendo. Não publique o site antigo que anuncia Free permanente.

### 3.4 Abrir as vendas

Faça esta etapa só com as provas de teste aprovadas, instalador compatível e pendências impeditivas de 6.1 resolvidas. Registre o horário da abertura e as versões de API/site/app.

**COBRANÇA REAL:** altere `MIGRATION_READY` para `true` no `wrangler.jsonc` e publique:

```sh
wrangler deploy
curl --fail --silent --show-error https://api.nexuside.app/v1/public/status
```

Confira `ready=true`, preço `5999/brl/month`, trial `15/2/false`. O status tem cache de até 60 segundos; aguarde e recarregue o site. Remova a restrição temporária de IP somente depois de conferir o conjunto live. De outra rede, prove login, trial e disponibilidade do botão de contratação.

Não execute cartões de teste, `stripe trigger` ou compras artificiais em live. A validação financeira final é acompanhar a **primeira compra legítima**, consentida, por um cliente real: valor correto, fatura paga, webhook 2xx, D1 atualizado, `/conta/` Pro e licença aceita no app. Até acontecer, registre “primeira compra live não confirmada”. A Stripe orienta realizar ensaios financeiros em ambiente de teste. Fonte: [Stripe testing][stripe-testing].

## 4. Reversão sem apagar dados

O primeiro movimento em um incidente de contratação é voltar `MIGRATION_READY=false`, publicar e conferir 503 autenticado. Mantenha webhook e portal funcionando para tratar assinaturas existentes. A flag não expira Checkout Sessions já emitidas e não cancela renovação automática.

| Etapa com problema | Como voltar | Conferência e limite |
| --- | --- | --- |
| Migrations, antes de usuários reais | Preserve o banco. Corrija a migration ou use outro banco novo e reconfigure o binding | Não existe down migration neste roteiro. `migrations list`, versão 4, `PRAGMA table_info` e `foreign_key_check` antes de retomar. |
| Secrets/OAuth, sem vendas reais | Restaure do cofre o conjunto anterior compatível e publique fechado. Restaure callbacks anteriores se necessário | Login real pelos dois provedores; não revogue imediatamente o segredo que ainda sustenta serviço válido. |
| Chave Ed25519 | Restaure o par que o app reconhece, somente se ainda for seguro, e mantenha vendas fechadas | Apps atualizados para outra pública podem deixar de funcionar. Roteiro não resolve rotação com duas chaves nem chave comprometida. |
| Deploy de API ou site | No Worker > Deployments, selecione a versão conhecida e use Rollback, após revisar sua configuração | Repita `/health`, `/ready`, status e login. Confira flag, secrets e D1 efetivos. Reversão de código não reverte conteúdo D1. |
| Domínio/DNS | Use o registro de 1.3 para restaurar a rota conhecida, apenas se o backend anterior estiver saudável e tiver dados compatíveis | TLS, login e webhook no destino correto. Não mandar usuários D1 novos para PostgreSQL antigo vazio. |
| Webhook | Corrija assinatura/Price/binding e reenvie os eventos reais que falharam pelo Workbench | 2xx, `processed_at` preenchido e assinatura reconciliada com Stripe. Não apague `stripe_events` para forçar repetição. |
| Passagem teste para live, antes de primeira compra | Feche tudo. Troque banco, secrets, Price e destino como um conjunto completo | Teste continua só no D1 de teste. Preserve ambos. Não deixe endpoint de um modo recebendo objetos do outro. |
| Depois de compra live | Feche novos checkouts, preserve D1 live e credenciais live. Corrija API/site sobre esse estado | Nunca “volte ao staging” com clientes pagos. Concilie Stripe e D1 por assinatura. Portal e webhook precisam continuar operando. |
| Suspensão indevida | `/admin/` > Restaurar acesso | Direito recalculado e auditoria `resume`. Não altera cobrança. |
| Extensão indevida | Preserve auditoria e encaminhe correção individual revisada | Não há ação inversa pronta. Não restaure o banco inteiro para retirar dias de uma conta. |

Fonte das limitações de rollback do Worker: [Cloudflare Rollbacks][w-rollback].

**Sessões de checkout já abertas:** no Stripe, localize sessões `open` emitidas antes do fechamento. Expire cada sessão confirmada, no modo correto. Isto é uma reversão deliberada, por ID live conferido um a um; nunca faz parte de uma sequência automática de ensaio. Para live, o comando é:

```sh
stripe checkout sessions expire <CHECKOUT_SESSION_ID_LIVE> --live
```

Conferência: `status=expired`. Sessões concluídas já podem ter cobrado e exigem conciliação, não expiração. Expirar a sessão no Stripe não limpa a reserva em D1: o checkout reutiliza a mesma chave de idempotência por uma janela de 23 horas e não há handler de `checkout.session.expired` que a libere. Antes de reabrir vendas, confira que o usuário consegue obter um checkout utilizável; não prometa recuperação imediata nem improvise `UPDATE` em produção. Fonte: [expire Checkout Session][stripe-expire] e [CLI resources][stripe-resources].

**Assinaturas reais:** se for necessário parar futuras cobranças, faça cancelamento no Stripe da assinatura correta e confira data/estado. Arquivar um Price, desligar Worker ou suspender usuário no Nexus não para as assinaturas existentes. Reembolso é uma operação financeira separada, com consequências reais. Não emita reembolso automático como “teste de rollback”. Fonte: [cancelamento][stripe-cancel].

**Recuperação D1:** antes de qualquer recuperação, exporte o estado atual para caminho privado novo. Use Time Travel/backup para investigar ou recuperar uma cópia, com plano de reconciliação das escritas posteriores. Restaurar o banco de produção para um horário antigo pode perder contas, eventos e auditoria posteriores e não desfaz cobranças Stripe. Não há comando de restauração destrutiva neste roteiro. Retenção e recuperação disponíveis devem ser conferidas no painel D1 > banco > Time Travel. Fontes: [Time Travel][w-time], [export/import][w-export].

## 5. Monitoramento nos primeiros dias

Na primeira hora, acompanhe cada contratação. Nos três primeiros dias, faça conferências no início e fim do expediente e após qualquer alerta. Escolha uma pessoa responsável por olhar os resultados; log habilitado sem acompanhamento não resolve incidente.

```sh
cd /Users/cleofasrocha/dev/nexus-cloud-api
wrangler tail nexus-cloud-api
```

Espere requisições e execuções agendadas. Use também Workers & Pages > Worker > Observability/Logs e Metrics para histórico, erros e latência. Tail pode amostrar eventos sob volume; não é ledger de cobrança. Logs podem conter URLs de callback com códigos transitórios. Restrinja acesso e não compartilhe saídas brutas. Fonte: [tail][w-workers].

| O que olhar | Onde/conferência | Ação se falhar |
| --- | --- | --- |
| Worker e banco | `curl` de 2.6 para `/health` e `/ready` | Se health passa e ready falha, investigar D1/binding/migrations. |
| Contratação | `/v1/public/status` e versão publicada | `ready` deve corresponder à decisão operacional. `billing.available` não valida chaves nem Price. |
| Webhook | Stripe Workbench > destino live > entregas e retries | Tratar 4xx/5xx e eventos pendentes. Reenviar depois da correção. |
| Assinaturas | Stripe Billing > Subscriptions e SQL abaixo | Comparar amostras active, past_due e canceled com acesso no Nexus. |
| Falha de pagamento | Stripe Billing/Revenue recovery e `grace_until` | Conferir prazo de 7 dias e política que não cancele antes sem intenção. |
| OAuth | Contas comuns Google/GitHub e erros 401/403/502 | Conferir callback, consentimento, secrets e origem CORS. |
| Administração | `admin_audit` | Conferir ator/alvo; suspensão continua separada do cancelamento Stripe. |
| Cron | Logs da execução no minuto 17 UTC | Não acumular tokens expirados; ausência de execução exige olhar trigger/deploy. |
| D1 e custos | D1 > banco > Metrics/Time Travel; Workers > Metrics/Usage | Acompanhar erros, volume, storage e limites do plano; confirmar retenção de recuperação. |
| App | Suporte e amostras em app instalado | Assinatura recusada, licença desatualizada, trial sem bloqueio ou sync indevido são incidentes de lançamento. |

Consultas operacionais sem e-mails, tokens ou payloads completos:

```sh
wrangler d1 execute DB --remote --command "SELECT type,count(*) AS pendentes FROM stripe_events WHERE processed_at IS NULL GROUP BY type;"
wrangler d1 execute DB --remote --command "SELECT status,count(*) AS total FROM subscriptions GROUP BY status;"
wrangler d1 execute DB --remote --command "SELECT count(*) AS gracas_vencidas FROM subscriptions WHERE status='past_due' AND grace_until<unixepoch()*1000;"
wrangler d1 execute DB --remote --command "SELECT action,count(*) AS total FROM admin_audit WHERE created_at>(unixepoch()-86400)*1000 GROUP BY action;"
```

Esperado: nenhum evento persistentemente pendente; assinaturas coerentes com Stripe. Uma linha `past_due` com graça vencida pode continuar armazenada: a autorização é recalculada na leitura. `accounts.plan` é cache e não deve ser usado sozinho como prova de acesso.

Antes de nova mudança, faça export privado e registre nome do banco, horário e versão. Não desligue Railway nem descarte backups até encerrar a observação e verificar que nenhum app/integração ainda depende dela.

## 6. Pendências e base de conferência

### 6.1 O roteiro não resolve

| Pendente ou não confirmado | Onde conferir | Impede declarar o quê |
| --- | --- | --- |
| Exceção para abrir checkout de teste, ou homologação separada | Decisão do operador de 2.8 | Ensaio manual completo mantendo a regra literal de `MIGRATION_READY=false` |
| Enforcement desktop de 2 agentes, sync bloqueado, fim do teste e suspensão | Implementação/release da Fase 4 e app instalado | Produto com os limites e bloqueios prometidos |
| Pública realmente fornecida ao instalador e privada Railway acessível | Pipeline/artefato e cofre Railway | Compatibilidade de licença após deploy |
| Renovação de licença, revogação e janela offline | `license-sync.ts`, `billing-ipc.ts`, testes em app instalado | Bloqueio no prazo combinado, inclusive offline |
| Validação completa de `sub`, `iss`, `aud`, `exp` e vínculo à conta no app | Revisão de segurança do consumidor desktop | Resistência à reutilização de licença entre contas. O emissor já inclui essas claims; isso não prova o consumidor. |
| Tolerância offline comercial definitiva | Plano da missão e decisão de produto | A API emite hoje até 24 h para Pro/trial e 5 min para acesso negado. Não prometer 7 dias Pro sem implementação. |
| Fase 3 do site integrada e publicada | Vite, Worker, `/conta/`, `/admin/`, CSP e teste real | Fluxo web completo. Este arquivo não altera essas telas. |
| Google liberado para público, DNS/TLS, proteção temporária e credenciais válidas | Painéis e conferências das etapas 2 e 3 | Publicação efetivamente funcional; nenhuma conta externa foi alterada nesta entrega |
| Elegibilidade da assinatura para Run simulation | Stripe > assinatura e guia de simulações | Renovação acelerada manual; existe alternativa aguardando ciclo/trial de teste |
| Primeira compra legítima live | Stripe, D1, `/conta/` e app após abertura | Fluxo financeiro live observado |
| Backup restaurável, retenção e alertas configurados | D1/Cloudflare e ensaio separado de recuperação | Recuperação operacional comprovada |
| Dados legados que apareçam depois da decisão de banco vazio | Railway/PostgreSQL e reconciliação | Troca simples de banco. Não inventar um import nem apagar registros. |

A API implementa extensão e suspensão/restauração; o cancelamento da assinatura é feito no Stripe (Customer Portal ou Dashboard) e a API reconcilia o estado pelo webhook. Este documento descreve sua operação. Ele não substitui revisão de segurança de autenticação, pagamentos, licença e dados de usuário. Não determina regras fiscais, reembolso ou termos comerciais do produto.

### 6.2 Implementação consultada

- API: `wrangler.jsonc`, `package.json`, `src/config.ts`, `src/index.ts`, `src/auth.ts`, `src/accounts.ts`, `src/providers.ts`, `src/billing.ts`, `src/stripe.ts`, `src/access.ts`, `src/licences.ts`, `src/admin.ts`, `src/admin-identity.ts`, as quatro migrations (`0001`–`0004`), testes de billing/admin/auth/licença/app/esquema e `docs/postgres-to-d1.md`.
- Site: `docs/plano-comunidade-planos-assinatura.md`, especialmente Fase 5, `docs/cloudflare-migration.md`, README, configuração Wrangler/Vite e scripts npm. O estado da Fase 3 deve ser rechecado após a integração dos escritores.
- App, lido em `main`: `docs/billing-stripe.md`, `server/package.json`, `server/scripts/provision-stripe.ts`, `shared/pricing.ts`, `src/main/persistence/billing-ipc.ts`, seu teste de licença, `src/main/license-sync.ts` e `src/main/backend-url.ts`.

O texto antigo de billing em `nexus-ide/main` descreve Free permanente. Essa parte está superada pela decisão do operador e pela API atual. O script de provisionamento e os comandos ainda foram conferidos no código.

Histórico da elaboração original: `npm test` passou com 81 testes (66 TypeScript e 15 de esquema); `npm run typecheck` passou. Na revisão de 30/09/2026 (branch `feat/shot-deep-link`), `npm test` passou com 97 testes — 81 TypeScript e 16 de esquema —, sem falhas; `npm run typecheck` e `wrangler deploy --dry-run` passaram. Os blocos shell/JavaScript foram conferidos sintaticamente sem execução. As 16 consultas SQL foram validadas em memória contra as migrations reais. As 20 variáveis de configuração estão cobertas; referências Markdown e varredura de segredos passaram. Não foram executados deploy, migrations remotas, login OAuth real, operações Stripe, build/publicação do site nem instalação/release desktop. `deploy --dry-run` ficou para o operador; nenhum resultado remoto foi presumido.

### 6.3 Fontes oficiais dos comandos e painéis

| Comando/procedimento | Fonte consultada |
| --- | --- |
| `npm ci`, scripts `npm test`, `npm run typecheck`, `npm run build`, `npm run stripe:provision` | [npm ci][npm-ci] e os `package.json`/script locais descritos em 6.2 |
| `wrangler --version`, `login`, `whoami` | [Wrangler geral][w-general], [instalação][w-install] |
| `wrangler d1 list/create/execute/export`, `migrations list/apply`, `--remote`, `--local`, `--command`, `--output` | [Wrangler D1][w-d1], [exportação D1][w-export]. SQL baseado nas migrations locais. |
| `wrangler deploy`, `deploy --dry-run`, `secret put`, entrada PEM por stdin, `secret list`, `dev`, `tail` | [Wrangler Workers][w-workers], [Secrets][w-secrets] |
| `routes.custom_domain`, painel de domínio | [Custom Domains][w-domains] |
| `workers_dev`, `preview_urls`, isolamento temporário | [workers.dev][w-workersdev], [Version URLs][w-previews], [WAF][w-waf] |
| `triggers.crons` e conferência agendada | [Cron Triggers][w-cron] |
| `curl --fail --silent --show-error --include --request --header --data` | [Manual curl][curl] |
| Gerar e comparar Ed25519, PEM PKCS8/SPKI | [Node.js crypto][node-crypto] |
| Google Authorized redirect URIs | [Google OAuth Web Server][google-oauth] |
| GitHub Authorization callback URL | [GitHub OAuth Apps][github-oauth] |
| Stripe `version`, `login`, credenciais do CLI | [CLI reference][stripe-cli], [login][stripe-login], [API keys][stripe-cli-keys] |
| Stripe `prices retrieve`, `--live` | [CLI resources][stripe-resources], [Price retrieve][stripe-price-get] |
| `stripe listen --events ... --forward-to ...` | [CLI listen][stripe-listen] |
| `stripe trigger checkout.session.completed`, `stripe trigger invoice.payment_failed` | [CLI trigger][stripe-trigger], [Billing testing][stripe-billing-testing] |
| `stripe checkout sessions expire <ID> --live` | [CLI resources][stripe-resources], [Checkout Session expire][stripe-expire] |
| Webhook, eventos, reenvio e assinatura | [Stripe webhooks][stripe-webhooks] |
| Product/Price, Customer Portal e cartões fictícios | [Products/Prices][stripe-prices], [Portal][stripe-portal], [Testing][stripe-testing] |
| Falha, relógio de teste, cancelamento e abertura live | [Billing testing][stripe-billing-testing], [Simulate subscriptions][stripe-simulate], [Cancel subscriptions][stripe-cancel], [Go live][stripe-live] |
| Reversão de versão e recuperação D1 | [Rollbacks][w-rollback], [Time Travel][w-time] |

## Apêndice A. Ensaio acelerado em base descartável

Fora do caminho normal. Este procedimento modifica datas de **uma conta fictícia em um banco descartável ou local**, nunca no banco que será promovido nem em produção. Ele adultera trial e graça diretamente, sem auditoria administrativa, e são duas atualizações independentes: a condição `role='user'` da primeira não protege a segunda. Prefira os testes automatizados ou aguarde os prazos reais. Exporte o banco e registre os valores originais antes; identifique o banco pelo nome físico, não pelo binding; confirme que a conta não é admin e não tem outra assinatura ou time ativo.

```sh
wrangler d1 export <NOME_D1_TESTE_ESCOLHIDO> --remote --output '<DIR_PRIVADO>/antes-expiracao-simulada.sql'
wrangler d1 execute <NOME_D1_TESTE_ESCOLHIDO> --remote --command "SELECT id,role,trial_started_at,trial_expires_at FROM accounts WHERE id='<ACCOUNT_ID_TESTE>'; SELECT stripe_subscription_id,status,grace_until FROM subscriptions WHERE account_id='<ACCOUNT_ID_TESTE>';"
wrangler d1 execute <NOME_D1_TESTE_ESCOLHIDO> --remote --command "UPDATE accounts SET trial_started_at=(unixepoch()-1382400)*1000,trial_expires_at=(unixepoch()-86400)*1000 WHERE id='<ACCOUNT_ID_TESTE>' AND role='user'; UPDATE subscriptions SET grace_until=(unixepoch()-1)*1000 WHERE account_id='<ACCOUNT_ID_TESTE>' AND stripe_subscription_id='<SUB_ID_TESTE>' AND status='past_due';"
```

Depois, atualize `/conta/` e renove a licença no app; espere `inactive` na API. Isso testa a avaliação de prazo vencido em uma base descartável; não prova sete dias reais de operação nem vale como conferência do banco de produção.

[w-install]: https://developers.cloudflare.com/workers/wrangler/install-and-update/
[w-general]: https://developers.cloudflare.com/workers/wrangler/commands/general/
[w-workers]: https://developers.cloudflare.com/workers/wrangler/commands/workers/
[w-d1]: https://developers.cloudflare.com/workers/wrangler/commands/d1/
[w-secrets]: https://developers.cloudflare.com/workers/configuration/secrets/
[w-domains]: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
[w-workersdev]: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
[w-previews]: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
[w-cron]: https://developers.cloudflare.com/workers/configuration/cron-triggers/
[w-waf]: https://developers.cloudflare.com/waf/custom-rules/create-dashboard/
[w-export]: https://developers.cloudflare.com/d1/best-practices/import-export-data/
[w-time]: https://developers.cloudflare.com/d1/reference/time-travel/
[w-rollback]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
[stripe-cli]: https://docs.stripe.com/cli
[stripe-login]: https://docs.stripe.com/cli/login
[stripe-cli-keys]: https://docs.stripe.com/cli/api_keys
[stripe-resources]: https://docs.stripe.com/cli/resources
[stripe-price-get]: https://docs.stripe.com/api/prices/retrieve
[stripe-prices]: https://docs.stripe.com/products-prices/manage-prices
[stripe-webhooks]: https://docs.stripe.com/webhooks
[stripe-listen]: https://docs.stripe.com/cli/listen
[stripe-trigger]: https://docs.stripe.com/cli/trigger
[stripe-portal]: https://docs.stripe.com/customer-management/configure-portal
[stripe-testing]: https://docs.stripe.com/testing
[stripe-billing-testing]: https://docs.stripe.com/billing/testing
[stripe-simulate]: https://docs.stripe.com/billing/testing/test-clocks/simulate-subscriptions
[stripe-cancel]: https://docs.stripe.com/billing/subscriptions/cancel
[stripe-live]: https://docs.stripe.com/get-started/checklist/go-live
[stripe-expire]: https://docs.stripe.com/api/checkout/sessions/expire
[google-oauth]: https://developers.google.com/identity/protocols/oauth2/web-server
[github-oauth]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app
[node-crypto]: https://nodejs.org/docs/latest-v22.x/api/crypto.html
[npm-ci]: https://docs.npmjs.com/cli/v11/commands/npm-ci/
[curl]: https://curl.se/docs/manpage.html
