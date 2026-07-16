# Billing Stripe do NexusIDE

## Oferta pública

- **Free permanente:** sem cartão, sem prazo e sem assinatura criada na Stripe.
  Mantém o núcleo local do produto para o usuário experimentar no ritmo real de
  trabalho.
- **Pro promocional:** **R$ 59,99 por mês**, cobrança recorrente mensal em BRL.
  É o único plano pago disponível para novos checkouts.
- **Team:** não aparece mais na oferta e novos checkouts são recusados. O suporte
  interno ao Price antigo é opcional apenas para processar assinaturas legadas.

Free permanente foi escolhido no lugar de trial porque o NexusIDE exige uso real
com projetos e CLIs antes de o valor ficar claro. O usuário não perde o ambiente
depois de poucos dias, e o upgrade pode ser associado a conveniências avançadas
que têm custo operacional, como sincronização e recursos de nuvem.

## Provisionar Product e Price

O Price é imutável na Stripe. Não converta o Price USD existente; crie um Price
novo em BRL e migre ou encerre assinaturas antigas de forma deliberada.

Com `STRIPE_SECRET_KEY` já disponível no ambiente seguro:

```bash
cd server
npm run stripe:provision
```

O comando é idempotente. Ele encontra ou cria o Product `NexusIDE Pro`, encontra
ou cria o Price mensal de 5.999 centavos em BRL, define-o como preço padrão e
imprime o valor que deve ser configurado em `STRIPE_PRICE_PRO`. Nenhuma chave
secreta é impressa ou gravada no repositório.

O Free não precisa de Product, Price ou Subscription na Stripe.

## Variáveis do backend

```text
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
PUBLIC_SITE_URL=https://nexuside.app
```

`STRIPE_PRICE_TEAM` é opcional e deve existir somente enquanto houver assinatura
Team legada. Em produção, segredos devem ficar no gerenciador de segredos da
plataforma de deploy.

## Webhook

Cadastre no Stripe Workbench o endpoint:

```text
https://SEU_BACKEND/v1/billing/webhook
```

Eventos necessários:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Copie o signing secret gerado para `STRIPE_WEBHOOK_SECRET`. O backend lê o corpo
raw, verifica a assinatura, deduplica eventos e consulta o estado atual da
Subscription antes de atualizar a licença.

## Customer Portal

No Dashboard, habilite para o cliente:

- atualizar a forma de pagamento;
- consultar faturas;
- cancelar a assinatura no fim do período.

Não habilite troca para Prices USD ou Team antigos. O botão **Gerenciar
assinatura** do app cria uma sessão autenticada do portal.

## Checklist de ativação

1. Provisionar no modo de teste e configurar `STRIPE_PRICE_PRO`.
2. Cadastrar o webhook de teste e o Customer Portal.
3. Fazer um checkout com cartão de teste e confirmar a licença Pro no app.
4. Testar `invoice.payment_failed`, cancelamento e retorno ao Free após a graça.
5. Repetir o provisionamento com a chave live e configurar as variáveis live.
6. Arquivar Prices antigos somente depois de verificar assinaturas existentes.

O checkout valida no servidor que o Price configurado está ativo, é recorrente
mensal, usa BRL e cobra exatamente 5.999 centavos. Uma configuração em USD ou com
valor diferente falha antes de criar qualquer cobrança.
