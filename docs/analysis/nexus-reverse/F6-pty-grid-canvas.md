# F6 — PTY grid + canvas infinito

## 0. Resumo (10 linhas)

1. Um PTY do Nexus não é `node-pty` direto: no macOS a cadeia é `/usr/bin/perl -T` (SIP) → `nexus-pty-supervisor` (assinado, self-responsible) → CLI real — descrita em [`../../DARWIN-PTY-SUPERVISOR.md`](../../DARWIN-PTY-SUPERVISOR.md) e montada em `src/main/pty/pty-host-entry.ts:107-127`.
2. `node-pty` roda num **utilityProcess separado** (`nexus-pty-host`), forkado preguiçosamente no primeiro spawn e re-forkado após crash (`src/main/pty/pty-host-client.ts:33-46`).
3. O main **nunca** segura um handle vivo de node-pty: fala com o host por mensagens tipadas via `pty-host-core.ts` (`pty-host-client.ts:12-18`).
4. Todo chunk de saída recebe um **número de sequência** e entra numa janela de replay de 1 MB no main (`src/main/pty/pty-manager.ts:751-764`).
5. O preload remonta a ordem: chunks fora de ordem esperam o buraco fechar via `pty:recover`, com teto — buraco irrecuperável é **aceito** com aviso visível (`src/preload/pty-gap-buffer.ts:1-27`).
6. No renderer, cada pane tem **UM xterm de vida longa** guardado num `Map` de módulo, chaveado por `pane.id` (`src/renderer/terminal/terminal-host.ts:53-63,244`).
7. **Persistência em reshape do grid**: a árvore de layout só renderiza *slots vazios*; o wrapper React re-parenteia o MESMO nó DOM. Split/close/mover não recria o terminal (`terminal-host.ts:56-62`, `attachHost` em `:1158-1160`).
8. **Grid e canvas compartilham a sessão** porque compartilham a chave: o nó do `@xyflow` nasce com `id: pane.id` (`src/renderer/components/CanvasView.tsx:64`) e chama o mesmo `attachHost` (`CanvasPaneNode.tsx:79`).
9. Trocar grid↔canvas é só trocar o componente raiz (`src/renderer/App.tsx:588`) — o `hosts` Map sobrevive porque é module-level, não estado React.
10. Destruição só acontece em `reconcileHosts(liveIds)`, quando o pane realmente sai da árvore (`terminal-host.ts:1916-1923`).

---

## 1. Trace ponta-a-ponta: do clique ao byte na tela

Este trace começa exatamente onde a Fase E do [`./F5-adapters-failover.md`](./F5-adapters-failover.md) parou (`pty-manager.ts:1245`, aplicação do `keyEnv`).

### Ida — renderer → PTY

| # | Passo | Arquivo:linha |
|---|---|---|
| 1 | O wrapper React do pane chama `attachHost(pane, slot)` no `useLayoutEffect` (grid) | `src/renderer/components/PaneLeaf.tsx:104-113` |
| 2 | `attachHost` faz `getOrCreateHost` e `slot.appendChild(host.element)` | `src/renderer/terminal/terminal-host.ts:1158-1160` |
| 3 | Primeiro attach: `term.open(element)`, agenda o scrollback pendente e pega lease de WebGL | `terminal-host.ts:1162-1176` |
| 4 | Se nada foi spawnado ainda, dispara `startSpawn(...)` | `terminal-host.ts:1191-1217` |
| 5 | `startSpawn` invoca `window.nexus.pty.spawn({cwd, cols, rows, kind, resume, paneId, adapterId, model, accountId, missionId, …})` | `terminal-host.ts:504-528` |
| 6 | O preload repassa por `ipcRenderer.invoke('pty:spawn')` — canal canônico em `channels.ts` | `src/preload/preload.ts:815-818`; `src/shared/channels.ts:7-18` |
| 7 | Main atende em `ipcMain.handle(PTY_CHANNELS.spawn, …)` | `src/main/pty/pty-ipc.ts:418` |
| 8 | `pty-manager` monta argv/env do adapter (resume, modelo, keyEnv) — ver F5 §1/E | `src/main/pty/pty-manager.ts:1062-1144,1245-1249` |
| 9 | O host é criado sob demanda: `createRealPtyHost()` → `createPtyHostBridge(transport)` | `src/main/pty/pty-host-client.ts:57-65` |
| 10 | `transport.ensure()` forka o utilityProcess `nexus-pty-host` a partir de `.vite/build/pty-host-entry.js` | `pty-host-client.ts:28-31,33-38,47-49` |
| 11 | O spec viaja por `postMessage` ao filho | `pty-host-client.ts:50-52` |
| 12 | No filho, `handleSpawn` recebe o spec e, no macOS, converte o comando via `darwinNodePtyBootstrapLaunch(cwd, file, args, env)` | `src/main/pty/pty-host-entry.ts:81,107-121` |
| 13 | `nodePty.spawn(launch.file, launch.args, {name:'xterm-256color', cols, rows, cwd, env})` | `pty-host-entry.ts:122-128` |
| 14 | O ABI do `@lydell/node-pty` foi patchado para que `helperPath` seja `/usr/bin/perl`; o `spawn-helper` mutável é removido | [`../../DARWIN-PTY-SUPERVISOR.md`](../../DARWIN-PTY-SUPERVISOR.md) §"Cadeia do @lydell/node-pty" (linhas 188-208) |
| 15 | Perl (SIP, taint mode) autentica as duas imagens do supervisor; o supervisor autentica a imagem viva do provider sob trap de `exec` e só então `PT_DETACH` | `../../DARWIN-PTY-SUPERVISOR.md:1-12,48-66` |

### Volta — bytes até a tela

| # | Passo | Arquivo:linha |
|---|---|---|
| 16 | `proc.onData(data => post({type:'data', sessionId, data}))` no host | `pty-host-entry.ts:154` |
| 17 | `post()` publica em `parentPort.postMessage` | `pty-host-entry.ts:68` |
| 18 | O client do main entrega ao bridge: `c.on('message', data => bridge?.dispatchEvent(data))` | `pty-host-client.ts:39` |
| 19 | `onSessionData` incrementa `session.outputSequence` e monta `{sessionId, data, sequence}` | `pty-manager.ts:751-752` |
| 20 | O chunk entra na janela de replay, podada em **1 MB** (`bufferedChars > 1_000_000`) | `pty-manager.ts:753-764` |
| 21 | Backpressure: acima de `MAX_UNACKED_OUTPUT_CHARS = 512 KB` não-ackados, o push é **pausado** (o chunk já está na janela; o pull de recover recupera) | `pty-manager.ts:658,766-771` |
| 22 | Caso contrário: `session.wc.send(PTY_CHANNELS.data, event)` | `pty-manager.ts:772` |
| 23 | O mesmo chunk alimenta os taps de orquestração (é daqui que o failover do F5 lê) | `pty-manager.ts:775`; consumidor em `src/main/orch/failover.ts:864-870` |
| 24 | Estado vira `busy` e o idle timer é armado com o `idleTimeoutMs` do adapter | `pty-manager.ts:776-780` |
| 25 | Preload recebe em `ipcRenderer.on(PTY_CHANNELS.data, …)` | `src/preload/preload.ts:266` |
| 26 | `PtyGapBuffer` só entrega o que é contíguo a partir do high-water; fora de ordem espera | `src/preload/pty-gap-buffer.ts:29-41` |
| 27 | Buraco: `ipcRenderer.invoke(PTY_CHANNELS.recover, …)` puxa do replay do main | `preload.ts:212`; handler em `pty-ipc.ts:532` |
| 28 | Entregue: `ipcRenderer.send(PTY_CHANNELS.acknowledge, {sessionId, sequence})` — é o ack que destrava o push do passo 21 | `preload.ts:204`; handler em `pty-ipc.ts:521` |
| 29 | Buraco irrecuperável (acima de 4 MB / 2048 chunks) é aceito e o `PTY_GAP_NOTICE` é injetado no stream | `pty-gap-buffer.ts:17-27` |
| 30 | No renderer, o callback de `window.nexus.pty.onData` escolhe a política de escrita | `terminal-host.ts:616-634` |
| 31 | `terminalOutputPolicy` decide por foco/visibilidade do pane/documento e modo de performance | `terminal-host.ts:620-627`; política em `src/renderer/terminal/terminal-render-policy.ts` |
| 32 | `writeTerminalOutput(host.term, data, policy)` — pane focado escreve já; pane oculto entra numa fila limitada a 2 MB | `terminal-host.ts:628-633`; limites em `src/renderer/terminal/terminal-output-scheduler.ts:63-90` |
| 33 | xterm renderiza; o WebGL addon vem de um pool de no máximo 8 leases | `terminal-host.ts:175-176,179-190` |

### Ida do teclado (input)

| # | Passo | Arquivo:linha |
|---|---|---|
| 34 | Envio comum: `window.nexus.pty.write` → `ipcRenderer.send('pty:write')` → `ipcMain.on` | `preload.ts:827`; `pty-ipc.ts:489` |
| 35 | Envio que precisa de confirmação (dispatch de missão, ditado): `writeConfirmed` é `invoke` e devolve boolean | `preload.ts:829`; `pty-ipc.ts:496` |
| 36 | Resize: `ResizeObserver` do host debounce 60 ms → `propagateHostSize` → `pty:resize` (SIGWINCH) | `terminal-host.ts:833-859,289-297`; `pty-ipc.ts:502` |

---

## 2. Inventário

| Componente | Arquivo:linha | Responsabilidade |
|---|---|---|
| Supervisor nativo | `native/darwin-pty-supervisor/main.c` (2 381 linhas) | Prova de coorte por (responsible_pid, responsible_unique_id); teardown fail-closed |
| Wrapper Darwin | `src/main/pty/darwin-pty-supervisor.ts` (1 337 linhas) | Monta/valida a invocação do helper a partir do main |
| Bootstrap stage-0 | `src/main/pty/darwin-node-pty-bootstrap.ts`, usado em `pty-host-entry.ts:110-116` | Converte (file,args,cwd,env) na cadeia perl→supervisor |
| Host PTY (utilityProcess) | `src/main/pty/pty-host-entry.ts:81-180,311-340` | Único lugar que chama `nodePty.spawn`; sem política própria |
| Supervisor do host | `src/main/pty/pty-host-client.ts:22-74` | Fork preguiçoso, re-fork pós-crash, `shutdownPtyHost` no quit |
| Bridge puro | `src/main/pty/pty-host-core.ts` (512 linhas) | Protocolo tipado `HostControlMsg`/`HostEventMsg`; escalação SIGTERM→SIGKILL |
| Gerente de sessões | `src/main/pty/pty-manager.ts:741-792,2168-2200` | Sequência, replay, taps, máquina busy/idle |
| Fronteira IPC | `src/main/pty/pty-ipc.ts:418-540` | 7 handlers; validação do payload do renderer |
| Canais canônicos | `src/shared/channels.ts:7-18` | Nomes compartilhados por preload e main, módulo sem dependências |
| Ponte do preload | `src/preload/preload.ts:204-290,815-833` | contextBridge; ordenação por sequência |
| Buffer de gap | `src/preload/pty-gap-buffer.ts:17-41` | Reordenação limitada + aceitação explícita de buraco |
| Host de terminais | `src/renderer/terminal/terminal-host.ts:244,1146-1218,1916-1923` | O `Map` `hosts`; ciclo de vida do xterm |
| Escalonador de saída | `src/renderer/terminal/terminal-output-scheduler.ts:63-95` | Fila limitada por pane oculto; drain com orçamento de 8 ms |
| Pool de WebGL | `src/renderer/terminal/webgl-lease.ts`, usado em `terminal-host.ts:175-190` | Máximo 8 contextos GPU vivos |
| Pane do grid | `src/renderer/components/PaneLeaf.tsx:104-118` | Slot + attach/focus no grid |
| Pane do canvas | `src/renderer/components/CanvasPaneNode.tsx:74-105` | Nó `@xyflow` que hospeda o MESMO xterm |
| Canvas | `src/renderer/components/CanvasView.tsx:57-88,182-338` | Nós, viewport, notas, pipes; `reconcileHosts` |
| Store de layout | `src/renderer/state/layout-store.ts:37-50,155-180,232-256` | Árvore de split, `canvasNodeLayouts`, persistência |
| Troca de view | `src/renderer/App.tsx:588` | `viewKind === 'canvas' ? <CanvasView/> : <PaneGrid/>` |

---

## 3. Não-óbvio / armadilhas

### 3.1 Onde mora o estado que sobrevive ao reshape

Três camadas distintas, e confundi-las é o erro comum:

| Camada | Onde vive | Sobrevive a quê |
|---|---|---|
| Processo do CLI | utilityProcess `nexus-pty-host` + supervisor nativo | Qualquer coisa no renderer, inclusive reload da janela |
| Buffer/sessão do xterm | `hosts: Map<string, Host>` **module-level** em `terminal-host.ts:244` | Remount React, split, close de irmão, troca grid↔canvas |
| Composição (árvore, posições) | Zustand `layout-store` + persistência em disco | Fechar o app |

A frase-chave está no próprio código (`terminal-host.ts:56-62`): *"The layout tree only renders empty slots; on every (re)mount a pane's React wrapper re-parents the SAME DOM node into its slot."* Por isso `attachHost` é idempotente — re-parentear o mesmo nó é um *move* no DOM, não uma recriação (`:1154-1156`).

O `Map` ser module-level (e não estado React/Zustand) é o que faz a troca de view não custar nada: React desmonta `<PaneGrid/>` e monta `<CanvasView/>` (`App.tsx:588`), mas o módulo não é recarregado.

### 3.2 Grid e canvas compartilham a sessão porque compartilham a CHAVE

Não há sincronização entre as duas views. A identidade é literal:

- `buildNode()` cria o nó do xyflow com `id: pane.id` (`CanvasView.tsx:57-64`) — o id do nó **é** o id do pane;
- `CanvasPaneNode` recebe esse `id` via `NodeProps` e usa `attachHost(pane, slot)` (`CanvasPaneNode.tsx:79`) e `focusHost(id)`/`blurHost(id)` (`:103-104`);
- `PaneLeaf` no grid faz exatamente o mesmo com `pane.id` (`PaneLeaf.tsx:107,116-117`).

Como `getOrCreateHost` chaveia por `pane.id` (`terminal-host.ts:1147`), as duas views resolvem para o mesmo `Host` — mesmo xterm, mesmo `sessionId`, mesmo PTY. O comentário em `CanvasPaneNode.tsx:49-52` diz isso com todas as letras: *"Switching views (canvas↔grid) just moves the same element to a different slot — zero PTY restart."*

### 3.3 O canvas *desanexa* o terminal em zoom baixo — e isso é só visual

Abaixo de `SNAPSHOT_THRESHOLD = 0.45` de zoom (`CanvasPaneNode.tsx:30`), o nó troca o xterm por um placeholder. O cleanup do efeito **remove os filhos do slot** (`CanvasPaneNode.tsx:85-87`) antes do React descartar a div — senão o slot morto seguraria o terminal (e o canvas WebGL) fora da árvore, pressionando a GPU. A sessão e o buffer continuam vivos em `terminal-host`; sair do snapshot re-parenteia o mesmo nó (`:80-84`).

Armadilha correlata: a lista de dependências do efeito é `[pane.id, isSnapshot, isVacancy]` com `exhaustive-deps` desligado, e o comentário explica por que `isVacancy` **precisa** estar lá — reivindicar uma vaga mantém o mesmo `pane.id`, então sem ela o efeito nunca re-rodaria e o pane reivindicado renderizaria um slot sem host (`CanvasPaneNode.tsx:88-93`).

### 3.4 Scrollback restaurado NÃO pode ser reescrito antes do primeiro `fit`

Armadilha com sintoma bizarro e sem volta, documentada no campo (`terminal-host.ts:89-99`): o conteúdo foi serializado na largura antiga; reescrevê-lo numa grade de 80 colunas faz a TUI do agente — que desenha caixas com posicionamento absoluto — sair entrelaçada (`cCaude Codeev2.1.220h`). E **reflow de resize não reconstrói** o que foi escrito com cursor absoluto.

Solução: o scrollback fica em `host.pendingScrollback` (`:1167-1168`) e só é escrito por `flushPendingScrollback` depois do primeiro `fit` bem-sucedido (`:114-128`, chamado em `:1181` e no `ResizeObserver`).

### 3.5 Divisor de fronteira de sessão

Um pane que já mostra conteúdo (scrollback restaurado ou sessão anterior no mesmo xterm) recebe `SESSION_BOUNDARY_NOTICE` quando uma sessão NOVA se conecta (`terminal-host.ts:583-589`). Sessão **adotada** (mesmo processo vivo continuando) não recebe — e o primeiro spawn de um pane vazio também não. O flag `hasVisibleContent` é travado no momento da atribuição justamente porque `flushPendingScrollback` remove a cópia pendente antes do xterm terminar de parsear (`:1169-1172`).

### 3.6 O main não é dono de handle de PTY — de propósito

`pty-host-client.ts:12-18` afirma que ele é o **único** módulo PTY que importa `electron` em runtime, para que `pty-manager` fique electron-free e seus testes unitários nunca forkem processo. Consequência prática para quem for mexer: o `pty-manager` fala em mensagens, não em objetos `IPty`.

Correlato: `onSessionData` ignora bytes tardios de uma sessão cuja autoridade já foi revogada e cujo teardown físico está em voo (`pty-manager.ts:746-750`) — senão o provider morto ainda dirigiria estado de UI, hooks e handoffs.

### 3.7 Ordem é garantida, entrega não é

O par sequência/ack é o que sustenta o backpressure: pausar o push é seguro **porque** o chunk já está na janela de replay e o pull de recover o traz de volta (`pty-manager.ts:766-771`). Mas o contrato tem um limite explícito: quando o buraco cresce além do orçamento — tipicamente porque a janela de 1 MB do main já evictou a sequência faltante — o buffer do preload para de esperar e **aceita o buraco**, avançando o high-water e emitindo o aviso (`pty-gap-buffer.ts:5-13,17-27`). Ou seja: *ordem* é invariante; *completude* é best-effort e visível.

### 3.8 O supervisor nativo tem um defeito conhecido de teardown

Não é teoria: em 05/08/2026 foram encontrados **10 supervisores zumbis** nesta máquina, dois vivos desde 04/08 queimando ~15% de CPU cada com o app fechado. A causa-raiz está em `native/darwin-pty-supervisor/main.c:1336-1341,1357-1363,1369` — o `for(;;)` cuja única saída é `prove_group_empty_twice`, e um inventário `incomplete` mantém o processo vivo **para sempre**. SIGTERM não resolve; só SIGKILL. Detalhes, `sample(1)` e o spec do fix em [`../2026-08-05-pty-supervisor-rust.md`](../2026-08-05-pty-supervisor-rust.md).

**Estado verificado no HEAD desta frente (2026-08-06):**

- O lado **Electron** do fix existe: `escalateDarwinSupervisorTermination` está em `src/main/pty/pty-host-core.ts:323` e é o fix do blocker da v0.25.0 citado em `pty-host-client.ts:58-62`.
- O lado **nativo** (Etapa 1) **NÃO foi aplicado**: `grep -n "PROOF_DEADLINE\|NEXUS_EXIT_PROOF_DEGRADED\|proof_deadline" native/darwin-pty-supervisor/main.c` retorna **zero ocorrências**. O comentário original segue intacto em `main.c:1336-1341` (*"No timeout permits the supervisor to exit without proof"*) e o `for (;;)` continua em `main.c:1369`.

Ou seja: o defeito descrito na auditoria de 05/08 permanece no binário nativo; o que existe hoje é a mitigação app-side, que impede o app de pendurar no quit mas **não** impede o supervisor órfão de queimar CPU depois que o responsável morre.

### 3.9 `reconcileHosts` é o único caminho de destruição — e é chamado por quem está na tela

`reconcileHosts(liveIds)` descarta os hosts fora do conjunto (`terminal-host.ts:1916-1923`). É chamado por `PaneGrid.tsx:53` **e** por `CanvasView.tsx:338` — ou seja, pela view ativa. Armadilha lógica: se uma view calculasse `liveIds` com um conjunto incompleto, mataria terminais vivos. `App.tsx:226` chama `reconcileHosts(new Set())` deliberadamente — descarte total (troca de workspace/teardown).

### 3.10 Resume de id exato pode expirar depois do spawn

O CLI só valida o id de conversa **depois** de subir, então o main não tem como saber sincronamente que o id capturado morreu. O renderer detecta pelo formato do óbito — `resumeMode === 'exact'` + exit ≠ 0 em menos de 10 s — e cai **uma única vez** para o comando de conversa mais recente do adapter (`terminal-host.ts:637-667`). Missão é diferente: falha de resume exato de missão é registrada como incidente e **não** cai para "conversa mais recente de outro pane" (`:670-685`). O anti-loop é explícito: esgotada a escada, o pane é preservado e o retry encerra (`:687-700`).

### 3.11 Correção de lacuna do F5: `spawn.ptyRequired` TEM consumidor

O F5 marcou como lacuna. Resolvido aqui: `src/main/real-mission-e2e-workspace.ts:333,389` lê `adapter.spawn.ptyRequired`. Ou seja, o campo é consumido pelo harness de missão real E2E, **não** pelo caminho de spawn normal (`pty-manager.ts` não o consulta) — o que confirma que, no fluxo comum, o flag é declarativo.

### 3.12 Sobre a documentação existente

[`../../DARWIN-PTY-SUPERVISOR.md`](../../DARWIN-PTY-SUPERVISOR.md) está **detalhado e coerente** com o código lido (cadeia perl→supervisor→provider, `PT_TRACE_ME`/`PT_DETACH`, manifesto de CDHash, exit codes 0/76/124/125/159). Não repeti seu conteúdo; este doc referencia. Ressalva: a linha 96-97 (*"Uma varredura incompleta mantém o supervisor vivo (fail-closed)"*) descreve o comportamento que a auditoria de 05/08 provou ser a causa dos zumbis — está tecnicamente correta, mas lida isoladamente soa como garantia, não como defeito conhecido. Ler junto com [`../2026-08-05-pty-supervisor-rust.md`](../2026-08-05-pty-supervisor-rust.md).

---

## 4. Essencial vs incidental

**Essencial:**

- O `hosts` Map module-level chaveado por `pane.id` (`terminal-host.ts:244`) — é a persistência inteira. Trocar por estado React quebraria todo reshape.
- Slot vazio + re-parent (`terminal-host.ts:1158-1160`) — o mecanismo, não uma otimização.
- `id: pane.id` no nó do xyflow (`CanvasView.tsx:64`) — sem essa igualdade, grid e canvas seriam sessões distintas.
- Isolamento do node-pty em utilityProcess (`pty-host-client.ts:33-38`) — crash do host não derruba o main.
- Sequência + ack + janela de replay (`pty-manager.ts:751-772`) — a única garantia de ordem no caminho.
- A cadeia perl→supervisor no macOS — é a fronteira de autoridade descrita em `../../DARWIN-PTY-SUPERVISOR.md`.
- `flushPendingScrollback` depois do fit (`terminal-host.ts:114-128`) — sem ela, todo restore de pane com TUI sai corrompido de forma irreversível.

**Incidental:**

- `SNAPSHOT_THRESHOLD = 0.45` (`CanvasPaneNode.tsx:30`) — número de ajuste de GPU.
- Pool de 8 leases de WebGL (`terminal-host.ts:175`) — orçamento; o terminal funciona no renderer de canvas 2D.
- Constantes do escalonador (`terminal-output-scheduler.ts:63-90`) — ajustáveis; a fila é que é essencial.
- Debounce de resize de 60 ms (`terminal-host.ts:833`).
- Teto do gap buffer (4 MB / 2048 chunks, `pty-gap-buffer.ts:17-20`) — política de degradação, não protocolo.
- Handles de pipe entre panes no canvas (`CanvasPaneNode.tsx:127-140`) — feature ("edges que conversam"), independente do transporte PTY.
- Sticky notes do canvas (`src/renderer/lib/note-nodes.ts`) — mesma superfície, zero relação com sessão.

---

## 5. Lacunas

- ~~lacuna: Etapa 1 do `PROOF_DEADLINE_MS` no `main.c`~~ — **RESOLVIDA** em §3.8: não aplicada (zero ocorrências no arquivo; `main.c:1336-1341,1369` intactos).
- lacuna: caminho Windows/Linux do PTY. `pty-host-entry.ts:107-121` mostra o ramo não-Darwin passando `command.file/args` direto ao node-pty, mas não verifiquei se existe supervisor equivalente (cross-referência: memória "Multi-plataforma obrigatório"; `main.c` é Darwin-only por `../2026-08-05-pty-supervisor-rust.md:61`).
- lacuna: `terminal-render-policy.ts` — li apenas o call site (`terminal-host.ts:620-627`); as regras concretas de `terminalOutputPolicy` e `terminalScrollbackLines` não foram abertas.
- lacuna: `adoption-repaint.ts` e o conceito de "sessão adotada" (`terminal-host.ts:608-611`). Aparece no trace mas o mecanismo de adoção (quem adota, quando) não foi rastreado.
- lacuna: hibernação de pane (`host.hibernated`, `heldSpawnPanes` em `terminal-host.ts:1191-1208`) — o gatilho e o fluxo de aprovação do usuário não foram seguidos.
- lacuna: como `canvasNodeLayouts` é atualizado no drag/resize (`CanvasView.tsx:186` expõe `updateCanvasNodeLayout`, mas não li a redução no store).
- lacuna: `pty-host-core.ts` (512 linhas) foi lido só pela interface citada em `pty-host-client.ts`; a máquina de estados do bridge e o `handleHostDown` não foram abertos.
- lacuna: qual componente chama `setTerminalSnapshotProvider` (`layout-store.ts:149`) para ligar a serialização do xterm à persistência — o provider existe, o registrante não foi localizado.
- lacuna: o pool de WebGL tem 8 leases, mas não verifiquei o critério de despejo quando o 9º pane pede lease (`webgl-lease.ts` não lido).

---

## 6. Auditorias relacionadas

- [`../../DARWIN-PTY-SUPERVISOR.md`](../../DARWIN-PTY-SUPERVISOR.md) — **referência autoritativa** da cadeia perl→supervisor→provider, threat model e exit codes. Não duplicada aqui; ver ressalva em §3.12.
- [`../2026-08-05-pty-supervisor-rust.md`](../2026-08-05-pty-supervisor-rust.md) — evidência de campo dos supervisores zumbis + spec do fix (Etapa 1) e do rewrite em Rust (Etapa 2). Base de §3.8.
- [`./F5-adapters-failover.md`](./F5-adapters-failover.md) — a Fase E do F5 desemboca no passo 8 deste trace; §3.11 fecha a lacuna do `ptyRequired` deixada lá.
- [`./F1-arquitetura-entrypoints.md`](./F1-arquitetura-entrypoints.md) — boot, Forge/Vite e limites de IPC; o `pty-host-entry.js` citado no passo 10 é um artefato de build daquele pipeline.
- [`../2026-08-04-analise-profunda-orquestracao-panes.md`](../2026-08-04-analise-profunda-orquestracao-panes.md) — panes sob a ótica da orquestração.
- [`../2026-08-05-electron-slim.md`](../2026-08-05-electron-slim.md) — baseline de tamanho citado como referência na decisão de Rust.
