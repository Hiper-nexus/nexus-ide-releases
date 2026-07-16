# Publicação do backend no Railway

O NexusIDE usa o Railway somente para o backend Node.js e PostgreSQL. O domínio
continua no Cloudflare, que aponta `api.nexuside.app` para o domínio público
gerado pelo Railway.

## Criar os serviços

1. No Railway, crie um projeto de produção e escolha **GitHub Repository**.
2. Selecione `cleofasvolarehost/nexus-ide`, branch `main`.
3. Adicione um serviço **PostgreSQL** ao mesmo projeto.
4. No serviço do backend, gere temporariamente um domínio Railway e aguarde o
   deploy concluir. A configuração em `railway.toml` instala, migra o banco,
   inicia o servidor e verifica `GET /ready`.

## Variáveis do backend

Cadastre os valores abaixo no serviço Node, sem versionar qualquer segredo:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
PUBLIC_BASE_URL=https://api.nexuside.app
PUBLIC_SITE_URL=https://nexuside.app
APP_DEEP_LINK_BASE=nexuside://

LICENSE_PRIVATE_KEY=<chave privada PEM>
LICENSE_PUBLIC_KEY=<chave pública PEM>
GITHUB_OAUTH_ID=<id OAuth GitHub>
GITHUB_OAUTH_SECRET=<segredo OAuth GitHub>
GOOGLE_OAUTH_ID=<id OAuth Google>
GOOGLE_OAUTH_SECRET=<segredo OAuth Google>

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
```

`STRIPE_PRICE_PRO` de produção é diferente do Price de teste. Gere-o somente
com a chave `sk_live_` usando `npm --workspace server run stripe:provision`.

## Domínio no Cloudflare

Depois de adicionar `api.nexuside.app` como domínio customizado no serviço
Railway, copie o destino CNAME indicado por ele. No Cloudflare, crie:

```text
Type: CNAME
Name: api
Target: <domínio fornecido pelo Railway>
Proxy status: DNS only inicialmente
```

Espere o certificado do Railway ficar ativo e valide:

```bash
curl -fsS https://api.nexuside.app/ready
```

Só depois de a resposta indicar `{"status":"ready"}`, habilite o proxy do
Cloudflare se desejar. O DNS precisa estar público antes de cadastrar o
webhook Stripe.

## Stripe live

1. No Dashboard Stripe, desligue o modo de teste.
2. Execute o provisionamento com uma `sk_live_` no ambiente seguro.
3. Salve o novo `STRIPE_PRICE_PRO` nas variáveis Railway e faça redeploy.
4. Cadastre o webhook `https://api.nexuside.app/v1/billing/webhook` e os eventos
   definidos em `docs/billing-stripe.md`.
5. Copie o signing secret para `STRIPE_WEBHOOK_SECRET` e faça outro redeploy.
6. Habilite o Customer Portal para atualização de pagamento, faturas e
   cancelamento ao fim do período.

## Validação antes da venda

1. Confirme `GET /ready` e `GET /live` em HTTPS.
2. Faça um checkout live interno e confirme que a conta recebe Pro.
3. Valide o webhook no Dashboard Stripe e teste cancelamento e pagamento
   recusado.
4. Confirme que o Free continua funcional sem cartão e sem assinatura Stripe.
