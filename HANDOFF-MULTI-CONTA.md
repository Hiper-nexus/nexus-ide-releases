# Handoff — Multi-conta (Providers / Contas)

Escrito em 23/08/2026, a partir de bugs reportados em voo pelo operador.
Base: `main` em `708f7650` (0.68.4 não publicada).

## O que o operador relatou, nas palavras dele

1. *"tenho duas contas Claude, elas devem aparecer aqui e também nos limites
   de uso de forma correta quando logadas"*
2. *"tá bem bugado na verdade o multi conta, tentei logar, ele não mostra ali
   as duas contas"*
3. *"precisa de uma melhoria na UI nesta parte de multi conta, precisa ser
   mais simples de usar e mais fácil visual, ali tá péssimo"*

Print do seletor de pane (⌘K) mostrava, lado a lado:
`Conta Claude › claude-opus-5` e `retorno › claude-opus-5`.

## O que JÁ foi corrigido nesta sessão (não refazer)

- **Kimi aparecia deslogado estando logado** — `seat-auth-readiness.ts`. A
  sonda roda `kimi provider list --json` e o classificador procurava a string
  `source=oauth`, que só existe na saída de TEXTO. No CLI 0.38 o JSON traz
  `providers` como MAPA e o assento como objeto aninhado `oauth: {...}`.
  Ambos os pontos corrigidos, com teste usando o payload real.
- **Rótulo genérico "Conta Claude"** — `account-default-label.ts` (novo).
  Ao salvar sessão sem digitar nome, o padrão passa a ser o e-mail da sessão
  viva (que já está no detalhe de autenticação — foi de lá que "retorno"
  saiu). Nome digitado continua vencendo.
- `auth-probe.test.ts` deixou de depender do estado real da máquina.

## O que investigar — hipótese principal do "não mostra as duas contas"

O modelo exige DOIS passos por conta, e a ordem importa:

1. logar a conta no CLI (`claude auth login`) — o CLI tem **um** arquivo de
   sessão;
2. **salvar/snapshot** essa sessão no cofre do Nexus
   (`ACCOUNT_CHANNELS.addActiveSession` → `addActiveSessionAccount`).

Se o operador loga a conta 2 **antes** de dar snapshot na conta 1, o CLI já
sobrescreveu o arquivo e a conta 1 nunca entra no cofre. O produto não avisa
nada disso. Suspeita forte de ser a causa do relato 2.

**Confirmar antes de mexer:** rodar o app empacotado (o dev usa
`.dev-user-data` isolado e não tem as contas reais), fazer o ciclo
login→snapshot→login→snapshot e comparar com login→login→snapshot.

Arquivos: `src/main/persistence/account-ipc.ts` (handler, linhas ~110-146),
`src/main/persistence/account-store.ts` (schema e `addActiveSessionAccount`),
`src/renderer/components/settings/AccountsManager.tsx` (UI).

## O que a UI precisa (relato 3)

O que existe hoje em `AccountsManager.tsx` é um formulário de operador:
adicionar, renomear, ativar, remover — sem explicar o modelo de duas etapas
acima. Proposta:

- **Nomear o fluxo, não o mecanismo.** O passo 2 chama-se "snapshot de
  sessão"; para quem usa, é "salvar esta conta no Nexus".
- **Uma linha por conta, com identidade real**: e-mail + qual está ativa +
  estado do login. Hoje uma conta sem rótulo vira texto genérico (corrigido)
  mas a linha ainda não mostra e-mail nem estado.
- **Tornar a sequência explícita**: um passo-a-passo curto ("1. entre na
  conta pelo botão · 2. salve no Nexus · repita para a segunda conta"), em
  vez de o operador descobrir a ordem por tentativa.
- **Avisar o risco real**: se o operador clicar em "entrar" com uma conta já
  salva pendente de snapshot, dizer que a sessão anterior será substituída.
- **Não adicionar trava.** Doutrina da casa (commits `886e9f4d`, `bba8e6aa`,
  `943bf47b`, `97ef2b0a`): remover atrito, nunca acrescentar confirmação,
  gate ou aviso novo. Explicar ≠ bloquear.

## Limites de uso por conta (relato 1)

Verificar `UsageQuotaSection.tsx` + `src/main/persistence/account-quota.ts`
(já projeta `label` por conta) e `quota-service.ts`. O relato é que os limites
não aparecem "de forma correta quando logadas" — checar se a projeção é por
conta ou agregada, e se conta sem uso registrado some da lista em vez de
aparecer zerada.

## Como verificar

- `npx tsc --noEmit`, `npx vitest run <arquivo>`, e
  `npm run security:renderer-sinks` para qualquer mudança de renderer/IPC.
- **Atenção aos nativos**: rodar o app em dev deixa `better-sqlite3` na ABI
  do Electron e a suíte cai com ~530 falhas falsas. `npm run rebuild:node`
  antes de testar — nunca `npm rebuild`.
- O dev usa `userData` isolado (`.dev-user-data`): contas reais só no app
  empacotado.
