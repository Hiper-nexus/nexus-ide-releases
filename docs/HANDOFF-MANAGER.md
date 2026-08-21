# HANDOFF — Resolver o Nexus de vez

> Para o agente manager. O operador **não estará presente para testar**. Você
> valida sozinho, com as ferramentas descritas na seção 6. Não declare nada
> pronto sem a prova exigida na seção 7.

---

## 1. O problema, em uma frase

O Nexus usa **o terminal como barramento de mensagens**: entrega handoff
digitando texto no PTY do destinatário e infere o aceite pelo desenho da TUI.
Overclock e BridgeSpace (ambos instalados nesta máquina e ambos funcionando)
usam **caixa postal durável**: o worker escreve o resultado num arquivo e quem
precisa lê. Por isso, no Nexus, "os panes não se enxergam".

Missão de teste que o sistema **nunca** conseguiu completar:

> `pergunte aos panes quanto é 1+1`

---

## 2. Evidência dura (colhida em 20/08, não repita o trabalho)

Banco de runtime do projeto:

```
.dev-user-data/project-runtime/projects/project-5c533be8…/checkout-2ce87372…/runtime.sqlite3
```

Placar histórico do barramento entre agentes, no banco inteiro:

| Fato | Valor |
|---|---|
| handoffs criados | 5 |
| handoffs `delivery_state=queued` sem **nenhuma** tentativa | 4 |
| tentativas de entrega já registradas | 1 |
| resultado dessa única tentativa | `failure_code = accept_timeout` |
| linhas em `handoff_ack_receipts` | **0** |

A única mensagem que o sistema já tentou entregar foi a **reclamação do próprio
watchdog** (`nexus-delegation-supervisor`, summary
`[zero-delivery:mission-…] Sem handoff nem arquivos após…`). E ela também
falhou.

Enquanto isso, o worker **respondia certo na tela** (`1+1 = 2`, `2`) e as
missões fechavam **verdes "Pronto"** com `result_json` dizendo:

> `"Entrega civil da Via Rápida (…): 398 arquivo(s) no disco (.cdp-eval.mjs, .gitignore, AGENTS.md, …)"`

A Via Rápida contava **o repositório inteiro** como prova de entrega.

Efeito colateral: workers sem ferramenta de pane "provavam" entrega escrevendo
lixo na raiz (`pergunta.txt`, `pane_report.txt` — apagar se ainda existirem).

---

## 3. Cadeia de causas (estado atual de cada elo)

| # | Elo | Estado |
|---|---|---|
| 1 | Worker responde | OK |
| 2 | Resposta vira handoff | **CORRIGIDO 20/08** (ver 4.2) — sem prova E2E |
| 3 | Handoff chega ao Maestro | **CORRIGIDO 20/08** (ver 4.1) — sem prova E2E |
| 4 | Missão fecha com a resposta | **QUEBRADO** — julga por contagem de arquivo |
| 5 | Custo de contexto proporcional | **QUEBRADO** — 8 KB de charter para somar 1+1 |
| 6 | Revisão (Code Review) | **QUEBRADO** — ver seção 5.3 |

---

## 4. O que JÁ foi corrigido (não refazer, construir em cima)

### 4.1 `src/main/orch/idle-delivery.ts`

**Dreno da caixa durável no idle do Maestro.** `flushQueue` só drenava a fila
**em memória**. Handoff submetido sem Maestro vinculado (`targetAuthority` →
`null`) não era enfileirado em lugar nenhum: ficava `queued` no SQLite e
nenhum idle posterior o relia. `redeliverPendingHandoffs` já existia, mas só
era chamado em respawn/recovery/resume — nunca no caso comum. Agora o Maestro
puxa a própria caixa toda vez que fica ocioso (throttle 3 s, guarda contra
entrega em voo).

**Aceite por estado durável.** `handleSubmitNotAccepted` não falha mais quando
o handoff já saiu de `queued` (list-ack de `nexus_handoff_list`,
`nexus_handoff_ack` ou consumo). A borda `busy` da TUI deixou de ser a única
prova de aceite.

`SUBMIT_ACCEPTANCE_WINDOW_MS` passou a ser exportado (testabilidade).

### 4.2 `src/main/orch/turn-end-handoff.ts`

`payloadReplyText` só falava o dialeto do Claude Code
(`last_assistant_message`). Panes Codex/Qwen produziam
`sem texto honesto (payload e transcript vazios)` — com o agravante de o
contrato mandar o worker **não** chamar ferramenta quando a resposta cabe em
280 chars, garantindo perda total. Agora reconhece, por normalização de chave
(minúsculo, sem `-`/`_`): `last_agent_message` (codex-rs),
`last-assistant-message` (notify), `assistant_message`, `agent_message`,
`prompt_response`, e o texto aninhado em `payload`/`data`/`turn`/`result`/`event`.

### 4.3 Verificação já feita

- `npx tsc --noEmit` — limpo.
- `idle-delivery.test.ts` 27/27 (2 testes novos).
- `turn-end-handoff.test.ts` + `hook-status-endpoint.test.ts` + `idle-delivery`
  → 81/81 (6 testes novos no total).
- `npx vitest run src/main/orch` → 3027 passando.
- **2 falhas pré-existentes**, confirmadas com `git stash` que já falhavam
  antes de qualquer alteração: `civilian-review-refusal.test.ts` e
  `mission-store.test.ts`. **Não são regressão. Corrija-as, mas não as
  atribua ao trabalho de transporte.**

---

## 5. O que FALTA (ordem de execução obrigatória)

### 5.1 Charter proporcional à tarefa — ALTA

Para responder `2`, um pane recebeu ~8 KB: Engineering Charter + Design
Charter (com lista de banimento de glassmorphism e emoji) + modo "ponytail
lazy senior dev". Antes disso, **5 servidores MCP × 30 s de timeout**
(`computer-use`, `dotcontext`, `firecrawl`, `supabase`, `testsprite`) = ~150 s
de espera pura por missão.

O commit `97a887d8` já tem essa intenção ("meta-de-pane zera o tier"), mas
zera **no caminho do Maestro**. O pane que a meta-de-pane abre entra pelo
**caminho do worker** e paga o charter inteiro. Faça o zeramento alcançar o
worker e pule o preflight de MCP quando a tarefa não usa ferramenta.

### 5.2 Conclusão por resposta, não por arquivo — ALTA

Matar contagem de arquivo como prova de entrega. Missão informacional fecha
com **o texto da resposta** no `result_json`. Missão nenhuma pode ficar
`Pronto` com handoff `queued`. Ponto de entrada: a autoridade de conclusão
(`verifyCompletedTaskPlanAuthority`) — a auditoria do próprio Overclock
registrou que essa função, *que decide se uma missão termina*, nunca havia
sido lida por ninguém. **Leia-a inteira antes de tocar.**

E o inverso também: falha de **transporte** jamais pode bloquear missão. O
comentário em `blockDeliveryFailure` já diz isso, e mesmo assim uma missão
ficou `blocked` por `accept_timeout`.

### 5.3 Bug novo — preparação de revisão falha

Reportado pelo operador em 20/08, com print. A UI mostra:

> **Não foi possível concluir esta etapa.**
> Não foi possível preparar a revisão. O rascunho foi preservado; tente novamente.
> A revisão não está visível. O rascunho foi preservado; prepare de novo para ver o resumo e iniciar.
> `[Preparar nova revisão]`

Reproduza, encontre a causa real (não trate o texto de erro como o bug),
registre como `docs/qa/items/F-XXX.md` no formato de `docs/QA-PROTOCOL.md` e
corrija. Suspeita inicial, **a confirmar**: relação com
`civilian-review-refusal.test.ts`, que está falhando.

### 5.4 Varredura de bugs

Rode a suíte completa, corrija o que estiver vermelho, e cace o resto com o
protocolo da seção 6 (log do main + CDP + SQLite). Um bug por arquivo em
`docs/qa/items/`, nunca um ledger único. `git add` por achado — nunca
`git add -A`.

---

## 6. Protocolo de raspagem do Overclock e do BridgeSpace

Ambos estão instalados nesta máquina. **Raspe antes de projetar** — o padrão
deles já está resolvido, não reinvente.

### 6.1 Overclock (concorrente que funciona)

| Caminho | O que extrair |
|---|---|
| `.overclock-app/briefs/*.md` | Contrato de missão em **arquivo**, com frontmatter (`id`, `missionId`, `status: aberto`) |
| `.overclock-app/briefs/.index.json` | Índice de briefs |
| `.overclock-app/progress/pane-*.md` | Checklist durável **por pane** |
| `.overclock-app/panes.json`, `pane-session.json` | Vínculo pane↔sessão que sobrevive a restart |
| `.overclock-app/messages.db` | `activity_log_v2`, `token_usage` (tabela pode estar vazia; use o schema) |
| `/Applications/Overclock.app/Contents/Resources/sidecar/` | `strings -a` no `index.js`/`index.jsc`. Símbolos já confirmados: `broadcast` (18×), `handoff_submit` (14×), `pane_read` (6×), `mailbox` (4×), `activity_log_v2` (10×) |

**A descoberta central, já feita — confirme e aplique:** todo brief do
Overclock termina com o mesmo contrato de worker de 6 passos, e o passo 4 é

> *"Write the result back into the item (Correção/notas + session id)."*

Ou seja, **a entrega é um artefato em disco**, não uma mensagem numa fila
volátil. Passo 6 é `handoff_submit` como última ação. Um brief já concluído
que serve de referência: `.overclock-app/briefs/HTA1OYCi-1.md`, com seção
`## Resultado`, commit `125ea891` e 17/17 testes.

### 6.2 BridgeSpace

`.bridgespace/swarms/<id>/` — `SWARM_BOARD.md`, `agents.json`, `plan`,
`transcript`, `status` e, o mais importante:

```
inbox/<Nome do Agente>/<timestamp>-<id>.json
   → { id, from, to, body, type, timestamp }
```

Caixa postal **por destinatário**, no filesystem. `@operator` é um endereço
como qualquer outro agente. O destinatário lê quando quer (pull). Sobrevive a
morte, restart e respawn — que é exatamente o que o Nexus não faz.

### 6.3 O que o Nexus já tem e ninguém usou

Antes de construir caixa postal nova, saiba que **ela já existe pela metade**:

- `nexus_handoff_list` (`src/main/orch/tools-handoff.ts`) já é leitura de
  caixa **e já marca `acknowledged` sozinho** ("List = recibo").
- `redeliverPendingHandoffs` (`idle-delivery.ts`) já relê o SQLite.
- `nexus_pane_ask` (commit `cfd5123c`) já faz pane conversar com pane.

O defeito nunca foi ausência de peça — foi peça não ligada. **Construa em
cima, não por cima.**

Cuidado com `nexus_pane_ask`: ele colhe a resposta por
`newOutputSince(before, after)`, ou seja, **diff de texto de tela**. Contra
TUIs que repintam tudo com `Thinking for 2s` / `Brewed for 1m 26s`, isso
captura frame de animação. E ele **não gera handoff**, então a autoridade de
conclusão continua enxergando silêncio. Unifique os dois canais.

---

## 7. Como validar sem o operador

### 7.1 Ambiente (a dança dos nativos — obrigatória)

`better-sqlite3` é compilado para uma ABI só. Errar isso custa uma hora.

```bash
npm run rebuild:node       # ANTES de rodar vitest
npx vitest run src/main/orch/<arquivo>.test.ts
npx tsc --noEmit

npm run rebuild:electron   # SEMPRE antes de subir o app
NEXUS_REMOTE_DEBUG=9235 npm start 2>&1 | tee /tmp/nexus-dev.log
```

### 7.2 Observabilidade (o que faltou nos 19 commits anteriores)

- **Log do processo main**: `/tmp/nexus-dev.log`. Sem `| tee`, o console do
  main vai para um terminal que ninguém lê — **foi essa cegueira que fez 19
  commits errarem o alvo**. Todo o diagnóstico da seção 2 saiu daí.
- **CDP**: opt-in por `NEXUS_REMOTE_DEBUG` (não é ligado por padrão, e está
  certo assim). Com ele:
  ```bash
  curl -s http://127.0.0.1:9235/json/list
  node .cdp-shot.mjs "<webSocketDebuggerUrl>" /tmp/shot.png   # screenshot
  node .cdp-eval.mjs "<webSocketDebuggerUrl>" "<js>"          # ler o DOM
  ```
- **SQLite**: consulte `handoffs`, `handoff_delivery_attempts`,
  `handoff_ack_receipts`, `missions.result_json`, `mission_panes`, `tasks`.

### 7.3 Critério de aceite — inegociável

A missão `pergunte aos panes quanto é 1+1` só está resolvida quando **todas**
forem verdadeiras:

1. Cada pane integrante responde e **gera handoff** (`handoffs` ganha uma
   linha por pane).
2. Todo handoff chega a `delivered=1` / `acknowledged`, com linha
   correspondente em `handoff_delivery_attempts` **sem** `accept_timeout`.
3. O Maestro **cita as respostas** no resultado da missão.
4. `missions.result_json` contém **`2`** — e não contagem de arquivo.
5. A missão fecha `done`. Não `blocked`, não `Pronto` mentiroso.
6. Nenhum arquivo novo na raiz do repositório.
7. Funciona com pane **não-Claude** (Codex) no leque — é onde quebrava.

Prove com: print do CDP + as linhas do SQLite + o trecho do
`/tmp/nexus-dev.log`. **Não aceite "os testes passaram" como prova**: o repo
tem 1049 arquivos `.test.ts` que ficaram verdes durante todo o período em que
o barramento entregava 0 de 5. Teste unitário com transporte mockado foi
exatamente o que mascarou este bug.

---

## 8. Regras da casa (de `AGENTS.md`)

- Teste co-localizado: `foo.ts` → `foo.test.ts`. Rode o teste focado antes de
  entregar.
- `npm run typecheck` após qualquer mudança de fonte.
- Mudança em renderer/IPC → `npm run security:renderer-sinks`.
- Fronteira sensível (`src/main/orch/`, `src/main/pty/`, `src/main/runtime/`):
  lease MCP transacional que escreve token no `mcp_config.json` real do
  usuário, sandbox Seatbelt/Bubblewrap, fuga de HOME. **Cheque antes de
  entregar.**
- Bug = `docs/qa/items/F-XXX.md`, um por arquivo (`docs/QA-PROTOCOL.md`).
- `git add` por achado. Nunca `git add -A` / `git add .`.

---

## 9. Fechamento: notarização e GitHub

Só depois do critério 7.3 cumprido e da suíte verde:

1. `docs/RELEASE-CHECKLIST.md` — percorrer item a item.
2. `npm run release:security` — renderer sinks + audit.
3. `npm run release:candidate` — assinatura, staple, smoke do ZIP, receipt.
4. Notarizar e publicar **usando o `nexus-notary`**.
5. Commits por achado, mensagem no estilo do histórico
   (`fix(orch): …` / `feat(orch): …`, com o caso de campo entre travessões).

**Não notarize com o critério 7.3 pendente.** O modo de falha desta base é
exatamente esse: declarar pronto sem a prova. Foi assim que quatro missões
ficaram verdes "Pronto" sem nunca ter respondido `1+1`.

---

## 10. Aviso final

Este projeto acumulou 19 commits de correção que não resolveram nada porque
todos consertaram **o empurrão** (detecção de idle, rebind, respawn, TTL de
worker, ack físico, reset de modo do xterm) em vez de trocar **o transporte**.
Se a sua correção for mais um ajuste de heurística de terminal, ela está
errada por construção.

O operador considerou abandonar o Nexus e forkar o `stablyai/orca` (MIT). A
avaliação honesta registrada: Orca é fundação melhor, mas é *fan-out
competitivo com worktrees isoladas* — não tem Maestro delegando, não tem
handoff de volta, e isolamento por worktree é o oposto de panes se enxergando.
Forkar não entrega a conversa entre panes; obriga a construí-la do zero de
novo. Por isso o caminho escolhido foi consertar o transporte.

**Entregue o `2` chegando ao Maestro. É esse o marco.**
