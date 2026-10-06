# Billing Stripe do NexusIDE

## Oferta pública

- **Teste de 15 dias:** começa no primeiro login verificado, com até 6 agentes simultâneos. Não há acesso
  permanente sem conta nem plano gratuito local. `plan: "pro"` com
  `access: "trial"` significa teste, não pagamento.
- **Pro promocional:** **R$ 59,99 por mês**, cobrança recorrente mensal em BRL.
  Permite agentes simultâneos ilimitados. É o único plano pago disponível para novos checkouts e é necessário após o teste.
- **Team:** não aparece mais na oferta. Licenças assinadas legadas com
  `access: "pro"` continuam reconhecidas; novos checkouts aceitam somente Pro.

## Autoridade da licença no desktop (Fase 4A)

O backend atual é `nexus-cloud-api`. `GET /v1/license`, exchange e refresh emitem
JWT Ed25519 (`alg: EdDSA`) com `sub`, `iss`, `aud: "nexus-desktop"`, `iat`, `exp`,
`plan`, `status`, `email`, `renewsAt`, `graceUntil`, `access`, `trialEndsAt` e
`limits: { maxAgents, cloudSync }`. O prazo máximo é 24 horas, ou 5 minutos para
`suspended`/`inactive`. O desktop não fixa quantidade de agentes nem sync para o
trial: os limites vêm do JWT. `maxAgents: null` significa ilimitado.

`src/main/persistence/billing-license.ts` verifica assinatura, tipos, algoritmo,
origem, audiência, emissão, prazo e `nbf`. O servidor legado em `server/` ainda
usa `LicensePayload`; o contrato atual é `DesktopLicenseClaims`. Tokens legados
sem `access` e `limits` não concedem acesso ao desktop.

`src/main/license-access.ts` é a autoridade única do processo. APIs:

```ts
getAccessState(): LicenseState
requireAccess(capability: 'use' | 'cloudSync'): AccessDecision
maxAgents(): number | null
applyLicenseToken(token: string): { ok: boolean; error?: string }
clearAccess(): void
onAccessChanged(listener: (state: LicenseState) => void): () => void
```

`AccessDecision` é `{ ok: true }` ou `{ ok: false; reason }`. Os motivos de acesso
são `login-required`, `verification-unavailable`, `invalid-license`,
`account-mismatch`, `license-expired`, `trial-ended`, `suspended`, `inactive`.
Para a capacidade de sync existe também `cloud-sync-disabled`. Bloqueado,
`maxAgents()` devolve 0; sem limite assinado devolve null. A autoridade não abre
nem fecha panes diretamente. `license-enforcement.ts` aplica o gate e reserva
um slot por filho físico PTY/ACP; `pty-manager.ts` protege spawns frios e adoção
warm, e `mission-engine.ts` protege mutações de missão. O renderer mantém a
árvore montada e inerte na `AccessBoundary`; fechar terminais segue permitido.
`gateRestoredAgents` segura a retomada enquanto o acesso está bloqueado.

O registrador `warm-agent-spawner.ts` observa `onAccessChanged`: bloqueio drena
somente filhos estacionados, preservando os adotados. `WarmPool.drain` invalida
reposições em andamento; um filho que termina de iniciar depois da drenagem é
encerrado. A reserva continua contando até a prova de finalização física.
A adoção reaproveita o slot, sem permitir um terceiro agente no teste de dois
slots. Cobertura: `pty-manager.test.ts`, `warm-pool.test.ts` e
`license-lifecycle.test.tsx` (autoridade assinada real, host/IPC simulados).

O arquivo `~/.nexus/license.json` guarda somente `{ "version": 2, "token": "…" }`.
Do formato antigo só o token é aproveitado. Campos externos nunca concedem
acesso. Cada consulta reverifica o JWT; o prazo do teste é o menor entre `exp`
e `trialEndsAt`. Sem token, com arquivo inválido ou prazo vencido, bloqueia.
Um timer avisa a interface; decisões nunca dependem de o timer já ter executado.
`billing.onChanged(() => …)` permite ao renderer buscar novamente `billing.get()`.
O evento não carrega token nem objeto IPC.

A conta é confirmada por `/v1/me` com a sessão autenticada, independentemente do
JWT. O cofre existente guarda `auth:account` com ID e hash da sessão; a licença
precisa ter o mesmo `sub`. Refresh atualiza esse vínculo. Importar um deep link
de outra conta falha sem substituir a licença atual. Logout deve chamar
`clearAccess()` antes de apagar os tokens de sessão/refresh; isso também invalida
logins/renovações pendentes. Login novo limpa o acesso anterior antes de gravar
as credenciais. Não há novo fluxo de logout nesta fase.

No boot, a leitura fria do Keychain espera o sinal de montagem da janela e cede
mais um turno antes de desbloquear o cofre. Consultas de acesso só leem secrets
já em cache. Instalações antigas sem vínculo precisam confirmar `/v1/me` online
uma vez. Renovação ocorre a cada 5 minutos ou antes de `exp`, com uma chamada
`/v1/license` por vez e retry após 30 segundos sem rede. Refresh também aplica
`licenca`. Respostas de outra geração/conta não são aplicadas. Polling de checkout
continua em `trial` e só conclui por pagamento em `access === "pro"` (ou pelo
limite de tentativas). Suspensão/inatividade válidas bloqueiam imediatamente,
inclusive se a gravação no disco falhar; nesse caso a revogação fica em memória.

Sem rede, um JWT ainda válido continua valendo. O relógio combina tempo de parede,
monotônico e um maior horário observado (`license:clock`) no cofre, gravado a cada
minuto e uma vez ao observar cada vencimento. Voltar o relógio não ressuscita um vencimento já
observado. Limite inevitável: sem fonte de tempo confiável online não há prova do
tempo transcorrido com o processo desligado; restaurar um cofre antigo, alterar
o binário ou controlar o sistema operacional está fora dessa garantia. Falha ao
persistir o selo mantém o acesso bloqueado. Cada consulta seguinte retenta a
escrita uma vez; escrita bem-sucedida limpa a falha, sem exigir rede quando o
JWT e o vínculo continuam válidos. Minha conta oferece “Tentar novamente”
também para `verification-unavailable`, por `refreshAccess` → `billing.get`
→ reavaliação/persistência no Main. Selo ausente ou que ainda exige validação
online continua fechado (H1). Cobertura: `license-access.test.ts` e
`AccountSection.test.tsx`. Um salto indevido
do relógio para o futuro pode manter o acesso bloqueado até aquele horário;
JWT de deep link nunca reduz esse piso, pois poderia ser um token antigo
reapresentado. Não há reset automático de relógio com base apenas em `iat`.

O bundle de produção exige `NEXUS_LICENSE_PUBKEY` Ed25519 válida no Vite; a chave
é embutida no Main. Desenvolvimento/testes podem abrir sem chave, com acesso
bloqueado. App empacotado sempre usa `https://api.nexuside.app`; override por
`NEXUS_BACKEND_URL` só funciona em desenvolvimento.

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

O teste é contado pelo backend, sem Product, Price ou Subscription de teste na Stripe.

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
4. Testar `invoice.payment_failed`, cancelamento e bloqueio após a graça.
5. Repetir o provisionamento com a chave live e configurar as variáveis live.
6. Arquivar Prices antigos somente depois de verificar assinaturas existentes.

O checkout valida no servidor que o Price configurado está ativo, é recorrente
mensal, usa BRL e cobra exatamente 5.999 centavos. Uma configuração em USD ou com
valor diferente falha antes de criar qualquer cobrança.
