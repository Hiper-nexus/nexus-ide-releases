# Handoff — Multi-conta (Providers / Contas)

Escrito em 23/08/2026, a partir de bugs reportados em voo pelo operador.
Base: `main` em `708f7650` (0.68.4 não publicada).
**Atualizado em 23/08/2026 (tarde): as três frentes abaixo foram resolvidas.**

## O que o operador relatou, nas palavras dele

1. *"tenho duas contas Claude, elas devem aparecer aqui e também nos limites
   de uso de forma correta quando logadas"*
2. *"tá bem bugado na verdade o multi conta, tentei logar, ele não mostra ali
   as duas contas"*
3. *"precisa de uma melhoria na UI nesta parte de multi conta, precisa ser
   mais simples de usar e mais fácil visual, ali tá péssimo"*

Print do seletor de pane (⌘K) mostrava, lado a lado:
`Conta Claude › claude-opus-5` e `retorno › claude-opus-5`.

## O que JÁ foi corrigido (não refazer)

### Primeira sessão (commit `708f7650`)

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

### Segunda sessão (este trabalho)

- **Bug "não mostra as duas contas" (relato 2) — auto-save pós-login.** A
  hipótese do modelo de 2 etapas estava certa: logar a conta 2 antes de
  salvar a conta 1 perdia a 1ª para sempre, em silêncio. Agora
  `AccountsManager.autoSaveSessionAfterLogin` roda quando o terminal de
  login fecha: sessão viva com e-mail fora do vault → entra sozinha
  (`addActiveSession` com o e-mail como nome). Best-effort; sonda sem
  identidade (Codex etc.) continua no caminho manual.
- **Dedupe no main** — `addActiveSessionAccount` ganhou
  `findSessionDuplicate`: mesmo e-mail (case/space-insensitive) ou, sem
  e-mail de nenhum lado, blob idêntico → ATUALIZA o blob, reativa e devolve
  a conta existente; nunca cria duplicata do mesmo assinante. Conta legada
  sem e-mail ganha a identidade no re-login da mesma sessão.
- **UI do multi-conta (relato 3)** — sem jargão ("vault" → Nexus; "Sessão
  logada" → "Salvar conta logada"), passo-a-passo explícito no hint e no
  footnote, selo **"sessão do CLI"** na linha cujo e-mail é o login vivo,
  aviso inline "sessão atual ainda não está salva" com botão
  **"Salvar esta conta"** (texto + ação; zero trava — doutrina `886e9f4d`).
- **Limites por conta (relato 1)** — a projeção por conta já existia; o
  problema era a linha `CLI nativo` duplicar a conta salva (3 linhas para 2
  assinantes). `UsageQuotaSection` agora sonda `authStatus` (arquivo/subprocesso,
  NUNCA Keychain na main thread) e dobra a linha nativa para dentro da conta
  de mesmo e-mail. Botão Atualizar refaz cota + sonda.
- **CHANGELOG + release-notes 0.68.4** atualizados (fixes novos).

## Validação da segunda sessão

- `npx tsc --noEmit` limpo.
- `npx vitest run src/main/quota src/main/persistence
  src/renderer/components/settings` → **541/541** (após `npm run rebuild:node`
  — nativos estavam na ABI do Electron).
- `npm run security:renderer-sinks` → 0 sinks.
- Fixture do `account-store-spawn.test.ts` ajustado: criava duas contas
  Claude com o MESMO e-mail (irreal) — agora e-mails distintos, como contas
  reais; o contrato de isolamento de env entre contas segue testado.

## Pendência (só dá para confirmar em voo)

Rodar o app **empacotado** (dev usa `.dev-user-data` isolado) e fazer o ciclo
login→(fecha terminal)→login→(fecha terminal): as duas contas devem aparecer
sozinhas em Contas, e "Uso e cotas" deve listar uma linha por conta sem a
"CLI nativo" redundante. Re-login da mesma conta não pode criar 2ª linha.

## Como verificar (para futuras mudanças)

- `npx tsc --noEmit`, `npx vitest run <arquivo>`, e
  `npm run security:renderer-sinks` para qualquer mudança de renderer/IPC.
- **Atenção aos nativos**: rodar o app em dev deixa `better-sqlite3` na ABI
  do Electron e a suíte cai com ~530 falhas falsas. `npm run rebuild:node`
  antes de testar — nunca `npm rebuild`.
- O dev usa `userData` isolado (`.dev-user-data`): contas reais só no app
  empacotado.
