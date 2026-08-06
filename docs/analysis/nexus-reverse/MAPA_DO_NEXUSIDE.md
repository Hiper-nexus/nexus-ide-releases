# MAPA DO NEXUSIDE — engenharia reversa de dentro para fora

> **Documento-mestre.** Consolida as 6 frentes de auditoria do NexusIDE.
> **Objetivo:** entender COMO o sistema funciona por dentro **sem ler o código**.
> **Versão auditada:** `nexus-ide` 0.27.0 (`package.json:2-4`)
> **Data:** 2026-08-06 · **Método:** leitura read-only do código + consolidação das auditorias existentes em `docs/analysis/`
> **Status:** ✅ **COMPLETO** — as 6 frentes (F1–F6) foram entregues e cada uma teve amostras de citação
> re-verificadas de forma independente pelo integrador contra o código.

---

## Como ler este documento

Cada afirmação técnica aponta para `caminho/arquivo.ts:linha`. Onde a verificação não foi possível
dentro do tempo da auditoria, a linha está marcada como `lacuna: <o que falta verificar>` e replicada
na §2 (Lacunas consolidadas). **Nenhuma afirmação sem fonte** — se não tem `arquivo:linha`, é lacuna.

**Aviso de alvo móvel (ler antes de conferir qualquer linha).** Esta auditoria foi feita com o
repositório **sendo modificado em paralelo por outra sessão de trabalho**. Durante a janela da
varredura entraram, entre outros, os commits `8bb74bfe` (16:16), `254ddab4` (16:21), `6dd48830`
(16:25, tocou `src/main/main.ts`) e `bc2c7416` (16:30, tocou `src/main/orch/mcp-server.ts`) —
justamente dois dos arquivos mais citados aqui. As citações deste conjunto foram conferidas contra o
working tree de **2026-08-06, entre ~16:25 e ~16:55**, e as frentes aceitas tiveram amostras
re-verificadas pelo integrador **depois** do commit das 16:30.

**Consequência prática:** os *números de linha* podem ter derivado desde então; os *nomes de símbolo,
arquivos e call sites* continuam válidos. Ao conferir uma citação que não bate, procure o símbolo no
arquivo antes de concluir que a afirmação está errada.

**Aviso de método (importante).** `docs/ARCHITECTURE.md` é um documento **prescritivo de design**,
declarado "DESIGN ONLY — nenhum código de produto nesta fase", datado de 2026-07-03
(`docs/ARCHITECTURE.md:3-4`). Ele descreve o que foi *decidido*, não necessariamente o que foi
*construído*. Nesta auditoria ele é tratado como **hipótese a verificar contra o código**, nunca como
prova. Divergências entre design e implementação são achado de primeira classe, e estão marcadas
como **⚠️ DESIGN vs CÓDIGO** ao longo das frentes.

---

## 1. Índice das frentes

| Frente | Assunto | Documento | Dono |
|--------|---------|-----------|------|
| **F1** | Arquitetura & entry points — como o app sobe do zero ao pronto | [F1-arquitetura-entrypoints.md](./F1-arquitetura-entrypoints.md) | Builder 1 |
| **F2** | MCP Hub — namespace `nexus_*`, registro, sync e propagação | [F2-mcp-hub.md](./F2-mcp-hub.md) | Builder 1 |
| **F3** | Hooks & lifecycle — eventos, matchers, dispatch, ordem | [F3-hooks-lifecycle.md](./F3-hooks-lifecycle.md) | Builder 2 |
| **F4** | Orquestração — squads, missões, handoffs, skill-gate | [F4-orquestracao.md](./F4-orquestracao.md) | Builder 2 |
| **F5** | Adapters multi-CLI + multi-conta/failover | [F5-adapters-failover.md](./F5-adapters-failover.md) | Builder 3 |
| **F6** | PTY grid + canvas infinito | [F6-pty-grid-canvas.md](./F6-pty-grid-canvas.md) | Builder 3 |

---

## 2. Lacunas consolidadas

> O que esta auditoria **não** provou. Cada item é uma dívida nomeada, não uma omissão silenciosa.
> Fonte completa na §5 de cada documento de frente.

### 2.1 Lacunas transversais (valem para o sistema todo)

| # | Lacuna | Por que importa |
|---|--------|-----------------|
| T1 | **Windows e Linux não foram traçados em nenhuma frente.** O boot fora do darwin (F1), a troca de conta do Claude (`claude-credential.ts:31` retorna `false` fora do macOS, F5) e a varredura de supervisores PTY (darwin-only, F1) são pontos cegos. | O projeto tem requisito multi-plataforma; este MAPA descreve **o NexusIDE no macOS**. |
| T2 | **Nenhum tempo real foi medido.** Todos os prazos citados (teto de quit 45 s, slow notice 10 s, mount deadline) são os **configurados**, não os observados. | Ninguém deve usar este documento para afirmar performance. |
| T3 | **Custo agregado de hooks por turno não medido** (F3 §5). Um pane Claude governado pode disparar 3–4 `curl` no mesmo `PreToolUse` (gate + status + managed + Overclock nesta máquina). | Latência somada por tool call é desconhecida. |
| T4 | **Alvo móvel** — ver aviso no topo: outra sessão commitou em `src/main/main.ts` e `src/main/orch/mcp-server.ts` durante a varredura. | Números de linha podem ter derivado. |

### 2.2 Por frente

**F1 — Arquitetura & entry points** (9 lacunas · [detalhe](./F1-arquitetura-entrypoints.md#5-lacunas))
- Corpo de `src/preload/preload.ts:60-757` não lido — **não foi confirmado se há validação zod no receptor do preload**, como `ARCHITECTURE.md §B.3` afirma. É a lacuna mais relevante da frente (toca a fronteira de segurança).
- `isLiveTrustedMainWindowSender` lido só até `trusted-ipc.ts:80`; checagem de `senderFrame` não verificada até o fim.
- `browser-preload.ts` caracterizado só pelo comentário em `forge.config.ts:400-402` — não lido para confirmar que não expõe API de página.
- `pty-host-core.ts` (a ponte pura) e `installRestoredAgentsGate()` não abertos.
- Onde `MAIN_WINDOW_VITE_NAME` recebe valor em runtime não confirmado.

**F3 — Hooks & lifecycle** (8 lacunas · [detalhe](./F3-hooks-lifecycle.md#5-lacunas))
- **Ordem real de execução quando Overclock e Nexus registram hooks no mesmo evento do Codex** não verificada em runtime — a precedência é decisão do binário `codex`, não do Nexus.
- `src/shared/agent-hook-listener.ts` tem 3.473 linhas; lidas ~1.528. Extractores de copilot/command-code/amp/antigravity não verificados.
- Não confirmado se alguma UI expõe `getManagedAgentHookStatuses()` — sem isso, falha de install fica invisível (F3 §3.8).
- `agent-status.ts:420` (`applyCanonicalHookEvent`) não lido por inteiro: a máquina de estados semântica é território de quem documentar status de pane.

**F5 — Adapters + failover** (8 lacunas · [detalhe](./F5-adapters-failover.md#5-lacunas))
- **Quem executa `adapter.detect`** — no discovery ele não é usado; consumidor real não localizado.
- **`spawn.ptyRequired` é declarado e validado, mas o call site que o consome não foi encontrado.**
- Isolamento do continuity pack vs. janela do detector de limite (`src/shared/failover-handoff.ts` não lido) — cruza com o bug conhecido da "cascata de limite fantasma".
- Cobertura real da refutação por API do provider: quais providers têm janela fresca de cota.
- `api-provider` tem `auth.keychainKey`, mas nenhum dos 9 builtins usa esse `kind` — consumidor não confirmado.

**F4 — Orquestração** (10 lacunas · [detalhe](./F4-orquestracao.md#5-lacunas)) — **a frente com maior dívida de cobertura**
- **Cobertura: ~20 de 288 módulos.** Ficaram fora, entre outros: PREVC e `mission-drive*`,
  `mission-degradation`, `mission-freeze-authority`, `plan-promotion-authority`,
  `worker-handoff-{contract,enforcement,ttl}`, `handoff-delivery-{outbox,policy,runtime-recovery}`,
  `final-validation-handoff`, `route-*`, `catalog*`, `skill-mirror`. Cada um merece frente própria.
- **`verifyCompletedTaskPlanAuthority` não foi lido** — é *a função que decide se uma missão termina*.
  O que está documentado é o wrapper. A afirmação "conclusão exige receipt verificável" está apoiada
  na descrição da tool e no prompt do orquestrador, **não no verificador**. É a lacuna mais séria
  deste MAPA.
- **O elo `claim → spawn do worker físico` não foi traçado** — quem chama `claimTaskDispatch` e onde o
  PTY do worker efetivamente nasce foi inferido por nome de módulo, não lido.
- **`server/` não foi aberto.** O briefing o lista em F4, mas o golden path traçado é inteiramente
  main-process + SQLite local. Falta determinar se `server/` participa da orquestração de missão ou é
  só relay remoto/OMP.
- **`.context/nexus/{policy.json,sensors.json,invariants/,attestations/}`** listados mas não lidos —
  quais invariantes são carregados em runtime, e por qual módulo, é desconhecido.
- Contagem real de tools divergente: `docs/orchestration.md` diz 24, o smoke de 2026-08-04 diz 142,
  `tools.ts` compõe ~20 famílias. O número correto exige executar o build.
- Schema real de `task_dispatch_queue` / `handoffs` / `mission_events` lido só por fragmentos de SQL
  nos módulos; migrações não abertas.

**F6 — PTY grid + canvas** (9 lacunas · [detalhe](./F6-pty-grid-canvas.md#5-lacunas))
- Caminho **Windows/Linux** do PTY: existe supervisor equivalente? `main.c` é Darwin-only.
- `pty-host-core.ts` (512 linhas) lido só pela interface; máquina de estados do bridge e
  `handleHostDown` não abertos.
- `terminal-render-policy.ts` lido só pelo call site — as regras concretas de `terminalOutputPolicy`
  não foram verificadas.
- "Sessão adotada" (`adoption-repaint.ts`) e hibernação de pane (`heldSpawnPanes`) aparecem no trace,
  mas os mecanismos não foram rastreados.
- Critério de despejo do pool de WebGL quando o 9º pane pede lease.

**F2 — MCP Hub** ([detalhe](./F2-mcp-hub.md#5-lacunas))
- **Os 3 módulos do hub não foram lidos linha a linha** (`mcp-hub-core.ts` 234 L,
  `mcp-hub-observers.ts` 422 L, `mcp-hub-sync.ts` 525 L). Os passos A2–A17 do trace vêm de
  `docs/MCP-HUB.md` + call sites confirmados. **Não verificados no código:** os limites 64 servers /
  512 tools, o `.bak` timestamped, o `rollbackFromBackup` e o fail-closed do Cline.
- O caminho de escrita real do sync (`applyMcpSync`) não foi exercitado nem lido — a garantia
  "nunca deleta" está apoiada no doc, não no código.

---

## 3. Sumário executivo — o que é o NexusIDE

NexusIDE é um **IDE Electron multi-agente** para macOS: um grid de terminais reais (PTY) onde cada
pane hospeda uma CLI de IA governada (claude, codex, agy, kimi, grok, aider, opencode), coordenados
por uma camada de orquestração própria — squads, missões e handoffs — exposta aos próprios agentes
como um servidor MCP embutido no namespace `nexus_*`.

O produto atende duas audiências no mesmo binário (`PRODUCT.md:9-20`): pessoas sem experiência em
programação, guiadas de ideia a entrega validada; e operadores que precisam inspecionar agentes,
worktrees, handoffs, custo e evidências em sessões longas. O caminho padrão pede apenas a próxima
decisão necessária; a complexidade operacional aparece por divulgação progressiva.

### 3.1 Topologia de processos

O app roda em **quatro processos**, com um entry de build por processo declarado em `forge.config.ts`:

| Processo | Entry de fonte | Declarado em | Papel |
|----------|----------------|--------------|-------|
| **Main** (Node/TS) | `src/main/main-bootstrap.ts` → `src/main/main.ts` (1139 linhas) | `forge.config.ts:395` | lifecycle, janelas, orquestração, MCP embutido, SQLite, secrets |
| **PTY Host** (utilityProcess) | `src/main/pty/pty-host-entry.ts` | `forge.config.ts:398` | spawn/write/resize/kill de PTY; isola crash do addon nativo |
| **Preload** (context-isolated) | `src/preload/preload.ts` | `forge.config.ts:399` | ponte `contextBridge`; superfície IPC tipada |
| **Renderer** (Chromium/React) | `main_window` | `forge.config.ts:408` | grid + canvas + panes, xterm.js, stores |

Dois preloads adicionais existem para superfícies isoladas: `src/preload/browser-preload.ts`
(`forge.config.ts:403`) para os browser panes, e `src/preload/pet-preload.ts` (`forge.config.ts:406`).

**O entry do main é deliberadamente minúsculo — e isso é uma restrição de ordem, não estilo.**
`src/main/main-bootstrap.ts` tem 13 linhas e faz exatamente duas coisas: chama
`ensureRegularMacOSActivation()` de forma **síncrona** (`main-bootstrap.ts:7`) e só então importa o
runtime real via `void import('./main')` (`main-bootstrap.ts:9`), com `app.quit()` se falhar
(`main-bootstrap.ts:11`). O comentário no próprio arquivo explica o porquê: o runtime empacotado
importa módulos nativos e um grafo grande do Electron, e **carregá-lo antes dessa chamada síncrona
fazia o macOS classificar o NexusIDE como `UIElement`** (`main-bootstrap.ts:4-6`) — ou seja, o app
perdia a política de ativação regular. Inverter essas duas linhas é uma regressão de produto, não de
performance.

Isso também confirma a correspondência com o artefato: o `main.js` minificado da raiz chama `e.t()`
e em seguida faz `Promise.resolve().then(()=>require("./main-B-7tm2vZ.js"))` (`main.js:1`) — a forma
compilada exata de `main-bootstrap.ts:7-9`.

### 3.2 Armadilha de entry point (nível MAPA)

O arquivo `main.js` na **raiz do repositório** não é fonte: é um **bundle rolldown minificado**
(274 bytes, linha única, sem newline final) que faz `require("./rolldown-runtime-D_FWMvbo.js")` e
carrega `./main-B-7tm2vZ.js`, logando `[main-bootstrap] runtime failed to load` em caso de falha
(`main.js:1`). É artefato de build emitido, não o ponto de partida do código.

Pior: ele é **untracked e explicitamente ignorado** — `.gitignore:82` contém `/main.js`, e
`git ls-files --error-unmatch main.js` falha com "did not match any file(s) known to git`". E está
**obsoleto**: a cópia na raiz é de **15/jul 12:54** enquanto `.vite/build/main.js` é de **04/ago
12:43**; ambos têm 274 bytes mas **diferem** (`cmp` acusa divergência no char 86 — nomes de chunk
hasheados distintos). É sobra de um build anterior largada na raiz.

O `main` declarado no manifesto é `.vite/build/main.js` (`package.json:6`) — também saída de build.
**Quem procura o entry real deve ir a `forge.config.ts:395`**, que aponta para
`src/main/main-bootstrap.ts`, que por sua vez importa dinamicamente `src/main/main.ts`
(`src/main/main-bootstrap.ts:9`). Ver F1 para o trace completo.

> ⚠️ Armadilha de leitura: abrir `main.js` na raiz procurando o entry point leva a um beco sem
> saída — código minificado, ignorado pelo git e desatualizado em ~3 semanas.

### 3.3 Fronteira de núcleo sensível

Três diretórios são declarados como núcleo sensível à segurança, por mutarem config real do usuário,
escaparem do confinamento de HOME do sandbox ou gerirem isolamento de processo (`AGENTS.md:23-33`):

| Caminho | Risco declarado |
|---------|-----------------|
| `src/main/orch/` | coordenador de orquestração, registry de MCP servers, spawn de agente CLI, **lease transacional de MCP** que grava bearer token no `mcp_config.json` real do usuário |
| `src/main/pty/` | session manager de PTY, sandbox advisory de processo (macOS Seatbelt / Linux Bubblewrap / Windows OCI) |
| `src/main/runtime/` | enforcement do sandbox de processo, escape de `processHome` do confinamento de HOME do Seatbelt |

---

## 4. Frentes consolidadas

### 4.1 F1 — Arquitetura & entry points
📄 Completo em **[F1-arquitetura-entrypoints.md](./F1-arquitetura-entrypoints.md)** · ✅ verificado por amostragem

**O que faz.** Leva o app de "processo Electron nasce" a "janela visível com IPC pronto", em cinco
fases: top level do main (antes de `ready`) → `app.whenReady` → criação da janela → renderer → PTY
host preguiçoso.

**Como faz, em uma passada.** Electron lê `package.json:6` e carrega `.vite/build/main.js`, bundle de
`src/main/main-bootstrap.ts` (`forge.config.ts:395`). O bootstrap fixa a activation policy do macOS
de forma síncrona e só então importa o runtime (`main-bootstrap.ts:7,9`). `src/main/main.ts` roda
código no top level — registra o scheme `nexus-app` (`main.ts:37`), switches de Chromium contra
throttling de timers em background (`main.ts:43-47`), fallback de GPU (`:65-82`) e o single-instance
lock (`:682-683`). Em `whenReady`, a **janela nativa nasce antes de qualquer serviço**, com o
renderer deferido (`main.ts:734`), o PATH do login shell é resolvido (`:769`), `bootstrap()` registra
todo o IPC (`:395-663,770`) e só então a navegação é liberada (`:771`).

**O ponto de decisão do sistema.** O boot é **fail-closed em três portões** — protocolo do renderer
(`main.ts:713-730`), CSP (`window.ts:257-271`) e bootstrap de IPC (`main.ts:776-789`). Qualquer um
falhando encerra o app em vez de expor um renderer parcial. E "pronto" **não** é `did-finish-load`:
a janela só aparece quando chega o IPC `renderer:mounted` (`src/shared/channels.ts:189`,
`window.ts:488-493`) ou o polling de `#root` (`window.ts:668-673`).

**Fronteira renderer.** Um único `contextBridge.exposeInMainWorld('nexus', api)`
(`src/preload/preload.ts:1586`) com 42 namespaces; `ipcRenderer` cru nunca é exposto.
`contextIsolation`/`sandbox` ligados e `nodeIntegration` desligado (`window.ts:290-297`), com fuses
de empacotamento fechando `RunAsNode`, `NODE_OPTIONS` e inspect (`forge.config.ts:412-421`).

**PTY é preguiçoso.** O `utilityProcess` do host **não sobe no boot** — só no primeiro spawn
(`src/main/pty/pty-host-client.ts:49-51`). Não achar o processo logo após o launch não é bug.

> ⚠️ **DESIGN vs CÓDIGO (achado forte da F1).** `ARCHITECTURE.md §B.3` cita o arquivo de contrato
> `src/shared/ipc/contracts.ts` — **esse arquivo não existe** (verificado). Os canais vivem em
> `src/shared/channels.ts` e em módulos por domínio. A mesma §B.3 promete `MessagePort` transferida
> ao xterm para o stream de bytes; a §B.2 do próprio documento se contradiz e admite que o stream
> ainda volta ao main. Não citar §B.3 como descrição do sistema atual.

### 4.2 F2 — MCP Hub (`nexus_*`)
📄 Completo em **[F2-mcp-hub.md](./F2-mcp-hub.md)** · ✅ verificado por amostragem

> ⚠️ **CORREÇÃO DE PREMISSA DO BRIEF.** "MCP Hub" não é um subsistema — **são dois**, que o briefing
> trata como um só. Separá-los é pré-requisito para entender qualquer coisa aqui. Eles se tocam em
> **exatamente um ponto**: a tool `nexus_mcp_servers` lê o config do hub (`tools-instruments.ts:502`).

| | **(A) Hub de configuração** | **(B) Servidor MCP embutido** |
|---|---|---|
| Onde | `src/main/mcp-hub/` (3 módulos) | `src/main/orch/mcp-server.ts` |
| O que faz | observa e sincroniza **configs** de MCP servers entre Nexus, Cursor, Claude Code, Codex, OpenCode e Cline | expõe as **142 tools `nexus_*`** às CLIs dentro dos panes |
| Executa tool? | **Não executa nenhuma** | é o executor |
| Dado | `.nexus/mcp-hub.json` (`schemaVersion: 1` + `servers[]`) | — |
| Sobe quando? | **não é registrado no boot** — `main.ts` não o importa | `initOrchestration()` no bootstrap (`main.ts:641`) |

**(A) — o hub é acionado por quem usa, não pelo boot.** Três consumidores reais:
`product-wave-ipc.ts:44-46` (observe/plan/apply), `discovery/workspace-discovery-service.ts:34` e
`orch/tools-instruments.ts:502` (import **dinâmico**). O sync é fail-safe por construção: `dryRun`
não escreve nada, export faz **fill-gaps e nunca deleta**, grava `.bak` timestamped antes de cada
escrita, e Cline é fail-closed (sem settings existente, não cria o arquivo — evita escrever no host
errado). Célula da matriz é `present | absent | unknown`, **nunca inventada**
(`shared/mcp-across-tools.ts:17`).

**(B) — 142 tools, autenticação por agente.** A porta é aleatória e **loopback-only**
(`mcp-server.ts:1183`); a **primeira coisa em toda request** é `bearerContext(req)`, e sem token
conhecido é `401` (`mcp-server.ts:1147-1153`). Cada spawn cunha um bearer **próprio daquele agente**
(`mcp-server.ts:681`), carregando `role`, `missionId`, `workerIncarnationId`, `readOnly` e as
allowlists de tool e skill. Falha em qualquer preparo libera o token e limpa **todos** os artefatos
(`mcp-server.ts:908-917`). A tabela completa das 142 tools — nome, params obrigatórios, efeito e call
site — está em [F2 §2.4](./F2-mcp-hub.md#24-tabela-de-todas-as-142-tools-nexus_); **9 delas** carregam
`requiresConfirm: true` (verificado no código: browser 4, git 1, media 3, vision 1).

**A propagação para a CLI não é uniforme — cada família recebe o servidor de um jeito diferente:**

| Família | Mecanismo |
|---------|-----------|
| Claude (HOME efêmero) | `--mcp-config <path> --strict-mcp-config` — o `--strict` impede o CLI de baixar os conectores MCP da conta OAuth, que afogavam o orquestrador (`mcp-server.ts:788-792`) |
| Claude de terceiro (GLM/LongCat) | HOME privado persistente + `--mcp-config` + `--settings` — compartilhar o `~/.claude` nativo fazia o binário **deslogar a sessão OAuth da assinatura** (`mcp-server.ts:793-807`) |
| Codex | argv puro, zero escrita em disco: `-c mcp_servers.<nome>.url=…`; o **segredo nunca entra no argv** (lido de `NEXUS_MCP_TOKEN` no env) e o timeout de 45 s é fail-closed deliberado (`cli-mcp-inject.ts:74-81`) |
| OpenCode · Kimi · Grok | sessão preparada com `env` + `extraArgs` + `providerStateHome` (`mcp-server.ts:867-884`) |
| **AGY / Gemini** | **não recebe MCP** — `canUseNexusMcp()` retorna `false` de saída (`cli-mcp-inject.ts:62`, verificado) |

> 🪤 **Armadilha: AGY é MCP-cego por decisão, não por bug.** A razão está no próprio código: *"AGY 1.1
> resolves MCP config from the real native profile and ignores the private HOME/GEMINI_CLI_HOME
> projection. Advertising it as MCP-capable makes workers wait forever"* (`cli-mcp-inject.ts:59-62`).
> Sua rota física de conclusão é o **stream do PTY**, não a tool. Quem esperar handoff via MCP de um
> worker AGY espera para sempre.

### 4.3 F3 — Hooks & lifecycle
📄 Completo em **[F3-hooks-lifecycle.md](./F3-hooks-lifecycle.md)** · ✅ verificado por amostragem

**O que faz.** Dá ao Nexus visibilidade sobre o que a CLI está fazendo (status) e o poder de **vetar**
uma tool antes que ela rode (skill-gate).

**Não existe "o" sistema de hooks — existem três canais independentes.** Confundi-los é o erro nº 1
ao ler este código. Cada um tem transporte, autenticação e semântica próprios:

| | **Canal A** — managed agent hooks | **Canal B** — status hooks | **Canal C** — skill-gate |
|---|---|---|---|
| Onde escreve | perfil **REAL e global** do usuário (`~/.claude/settings.json`, `~/.codex/hooks.json`) | por spawn/sessão, **nunca** no perfil real | só dentro do `$HOME` efêmero |
| Código | `src/main/agent-hooks/` | `src/main/orch/hook-status-config.ts` + `src/vendor/emdash/hooks/` | `src/main/orch/hooks-gen.ts` |
| Servidor | próprio (`hook-http-server.ts:98`) | MCP embutido (`mcp-server.ts:1147`) | MCP embutido |
| Token | por **app**, hex 24B, header `X-Nexus-Agent-Hook-Token` | por **pane**, `Bearer` | por **pane**, `Bearer` |
| Bloqueia? | **nunca** (`exit 0` incondicional) | **nunca** (`\|\| true` por construção) | **só o `pretool`** |
| Consentimento | **sim** — diálogo nativo antes de tocar config global | não aplicável | não aplicável |

**Só um evento no sistema inteiro tem poder de veto.** `pretool` é síncrono e **fail-closed**: sem
credencial, com stdin inválido ou com o gate fora do ar, o script sai `process.exit(2)`
(`hooks-gen.ts:102-109`, verificado) — que é como o Claude Code cancela a tool call. `posttool` é
no-op server-side (`mcp-server.ts:451-453`, verificado: responde `allow:true` e retorna).

**Invariante transversal — hook nunca autoriza conclusão.** `authorizesEvidence:false` e
`authorizesMissionCompletion:false` estão hard-coded como literais em **três lugares independentes**
(`hook-http-server.ts:183-191`, `agent-hook-activity-mapper.ts:50-55`, `hook-status-endpoint.ts:148-157`).
É o que impede um hook de "declarar missão cumprida".

**Ordem de execução: o Nexus não orquestra, co-existe.** Não há scheduler entre canais — quem
serializa é a CLI hospedeira. O Nexus controla só a *posição* (sempre anexa por último no seu evento,
`claude-hook-service.ts:103-108`) e garante idempotência **por marcador** `NEXUS_HOOK_STATUS`
(`hook-commands.ts:34-37`), não por posição. Deliberadamente não escreve em arquivo de projeto para
não entrar na disputa de precedência home-vs-projeto (`hook-status-config.ts:8-10`).

> ⚠️ **CORREÇÃO DE PREMISSA DO BRIEF (achado forte).** `.agents/hooks.json`, `.codex/hooks.json` e
> `.grok/hooks/` na raiz do repositório **não são do NexusIDE** — são artefatos do **Overclock**.
> Verificado: `.agents/hooks.json` contém literalmente `overclock-handoff-deliver` apontando para
> `/Applications/Overclock.app/...`; os três estão gitignorados e untracked; e nenhum código do Nexus
> lê ou escreve neles — os installers escrevem no **HOME** (`codex-hook-service.ts:46-48`), nunca no
> cwd. Efeito prático nesta máquina: um pane Codex com cwd na raiz do repo dispara hooks do Overclock
> **e** do Nexus no mesmo evento. É contaminação de ambiente de dev, não design do Nexus.

> ⚠️ **AUDITORIA SUPERADA.** [`../2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md)
> afirma que o Stop-hook bloqueia a parada do worker. **Não é mais verdade em HEAD:** o commit
> `5ac0fd58` (verificado, um dia *depois* da auditoria) tornou o `stop` desacoplado e **fail-open** —
> grava em tmp, relança `detached`, `process.exit(0)` (`hooks-gen.ts:69-90`). Hoje **nenhuma CLI tem
> Stop-hook bloqueante**. `evaluateStop` (`gate.ts:619-639`) segue correto e ativo, mas seu veredito
> não chega a lugar nenhum. A garantia real é `src/main/orch/worker-handoff-enforcement.ts`, que não
> depende de hook.

### 4.4 F4 — Orquestração (squads / missões / handoffs)
📄 Completo em **[F4-orquestracao.md](./F4-orquestracao.md)** · ✅ verificado por amostragem

> **Cobertura declarada, não fingida.** `src/main/orch/` tem **288 módulos não-teste** (559 arquivos
> `.ts` no total, medido 2026-08-06 ~16:55). A F4 traça **um golden path** e cita ~20 deles; toda a
> superfície não coberta está nomeada como lacuna na §5 daquele doc, não silenciada. Este é o
> subsistema mais extenso do NexusIDE e o menos coberto proporcionalmente por esta auditoria.
>
> 🪤 **Armadilha de contagem (verificada).** Não use `grep -v test` para contar: ele derruba três
> arquivos **não-teste** cujo nome contém a substring — `agent-attestation-gate.ts`,
> `agent-attestation-lookup.ts`, `guided-mission-planner-test-harness.ts` — e devolve 285. O correto
> é `grep -v '\.test\.'`.

**O que faz.** Transforma "o operador quer algo" em "workers autônomos entregaram, com prova".

**Uma missão não nasce de um comando — nasce de uma escada de autoridade de 5 degraus IPC:**
`arm → submitIntent → approveIntent → bootstrapOrchestrator → kickoffSubmit`
(`src/shared/orch-channels.ts:32,34,36,41,52`). O renderer **nunca carrega autoridade**: em
`bootstrapOrchestrator` ele manda **só** `missionId` e o main lê todo campo de runtime dos próprios
stores (`orch-channels.ts:38-41`).

**A aprovação tem uma fence, e ela existe por um motivo real.** Entre abrir o diálogo nativo do SO
(`orch-ipc.ts:2102`) e o retorno (`:2110`) há um `await` de duração humana — janela em que o operador
pode trocar de squad, anexar arquivo, ou o renderer pode morrer. Por isso o candidate é **recalculado
e comparado**; qualquer divergência mata o approve com `approval_stale` (`orch-ipc.ts:2111-2118`), e
o workspace scope é revalidado **três vezes** no mesmo handler.

**Persistência é por checkout, não global.** O banco vive em
`<userData>/project-runtime/project-<digest>/checkout-<digest>/runtime.sqlite3`
(`project-runtime-manager.ts:222`, verificado), com os nomes derivados de **digest**, não de caminho
legível, e guarda anti-symlink antes de abrir (`:226-233`). **Não existe "o banco do Nexus"** — o
mesmo projeto em dois worktrees tem dois bancos independentes.

**Skill-gate duplo e assimétrico.** O server-side é a **autoridade** (`mcp-dispatch.ts:636`, sobre o
bearer do pane, no processo main — nada contorna); o client-side é **feedback** para o agente ver a
recusa dentro da CLI. Três listas moldam o gate:

| Lista | Conteúdo | Semântica |
|-------|----------|-----------|
| `ALWAYS_ALLOWED` (`gate.ts:73`, verificado) | `handoff_submit`, `handoff_list`, `handoff_ack`, `worker_heartbeat`, `toolsearch` | Passam **independente** de allowlist — sem isso um worker gated não teria como entregar e a missão travaria por construção. |
| `REQUIRES_EXPLICIT_ALLOW` (`gate.ts:88-96`, verificado) | `remote_spawn`, `remote_cli_detect`, `remote_tmux_list`, `remote_bridge_status`, `agent_spec_write`, `catalog_install`, `cron` | **Inverte o default.** Alcançam fora do sandbox, então exigem grant nominal. |
| `ORCHESTRATOR_DENIED_TOOLS` (`gate.ts:98-104`) | 13 tools de escrita | Fronteira de papel: o orquestrador coordena, não implementa. |

> ⚠️ **Armadilha semântica mais perigosa do sistema.** `allowedTools: null` **não significa "tudo"**.
> Significa "irrestrito **para tools comuns**" — as 7 de `REQUIRES_EXPLICIT_ALLOW` continuam negadas
> (`gate.ts:128-135`). Um agente com prompt injetado e allowlist default **não** herda SSH para host
> arbitrário, mutação de `~/.claude/agents`, abertura da ponte de rede, install de catálogo ou cron.

**Handoff: `status: 'success'` não conclui nada.** A própria descrição da tool declara que `status` e
`artifacts` são *"untrusted delivery metadata and never complete a mission"*
(`tools-handoff.ts:81`) — só `evidenceIds` já emitidos e ligados pelo Nexus satisfazem o receipt. O
handoff é linha durável em SQLite, entregue no PTY do orquestrador **só quando ele fica idle**
(`idle-delivery.ts:1057,1089`) — injetar no meio de uma resposta corromperia o turno. Um worker
"bem-intencionado" que escreve um resumo bonito e declara sucesso **não move a missão**.

**Screenshot é prova, não foto.** `nexus_browser_screenshot` (`tools-browser.ts:211-241`) exige posse
do pane, verifica a superfície de review **antes e depois** da captura, e **lança** se a URL
capturada não bater — *"automated design-review screenshot came from another URL"*. Sem isso, um
screenshot de outra URL viraria evidência de review.

> ⚠️ **DESIGN vs CÓDIGO.** `docs/orchestration.md:53-55` afirma que "o Stop-gate bloqueia a saída sem
> handoff (máx. 3 tentativas)". As três primeiras afirmações conferem; **a última não** — mesmo
> achado da F3 (commit `5ac0fd58`). O mesmo doc diz "24 tools" (`:4,:24`) enquanto o smoke empacotado
> de 2026-08-04 reportou **142**.

### 4.5 F5 — Adapters multi-CLI + multi-conta/failover
📄 Completo em **[F5-adapters-failover.md](./F5-adapters-failover.md)** · ✅ verificado por amostragem

**O que faz.** Transforma "existe uma CLI de IA instalada nesta máquina" em "um agente autenticado
rodando num pane", e mantém isso vivo quando uma conta esgota crédito.

**Uma CLI não é código — é um JSON.** O adapter é declarativo, validado por Zod
(`src/shared/adapter-types.ts:140-190`), embutido no build (`src/adapters/builtin/index.ts:12-22`)
ou solto em `~/.nexus/plugins/adapters/` com hot-reload (`src/main/adapters/adapter-registry.ts:440-450`).
São **9 builtins**: claude, codex, agy, kimi, grok, aider, opencode, glm, longcat. JSON inválido é
descartado com log, não derruba o app (`adapter-registry.ts:174-184`).

**O JSON descreve mecânica, nunca autoridade.** Esta é a linha de segurança central da frente: um
adapter do usuário pode declarar `bin`, `spawn`, `env` e `quirks`, mas **não pode se promover**. As
capacidades de release são calculadas main-side e exigem `origin === 'builtin'`
(`adapter-registry.ts:94-135`); `verifiedMaestro` ainda passa por uma allowlist literal de dois ids,
`VERIFIED_ORCHESTRATOR_BUILTINS = new Set(['claude','codex'])` (`adapter-registry.ts:55`, verificado).
Ou seja: soltar um JSON no home nunca vira escalação de privilégio.

**Detecção não usa o PATH do Electron.** Um app aberto pelo Finder herda PATH mínimo, então o Nexus
pergunta ao **login shell** (`src/main/path-resolver.ts:139-168`, via `$SHELL -lic`) e funde com
diretórios curados (`:72-104`). O spawn sempre usa o **caminho absoluto** resolvido, nunca o nome nu
(`adapter-registry.ts:548-566`).

**Auth é subscription-first — e isso é decisão de produto, não detalhe.** Sessão nativa viva vence a
key guardada **e suprime** as env vars de key herdadas (`subscription-auth.ts:56-57`, verificado). O
motivo está escrito no código: injetar `ANTHROPIC_API_KEY` num pane logado por OAuth **desviaria o
billing** do plano para a API (`subscription-auth.ts:11-18`).

**Segredo nunca vira plaintext — provado por três call sites independentes.** (1) cifra na escrita
via `safeStorage.encryptString` em `~/.nexus/secrets.enc` (`secrets-store.ts:293`, arquivo `0600`);
(2) **falha fechada** — sem storage seguro a escrita retorna erro em vez de degradar
(`secrets-store.ts:284-286`, verificado; no Linux o backend fraco `basic_text` é rejeitado);
(3) nunca em `argv` — a troca de conta do Claude passa o comando por **stdin** de `security -i`
(`claude-credential.ts:156-172`). Ressalva honesta registrada pela própria frente: homes gerenciados
de CLIs file-auth precisam de um `auth.json` real em disco, escrito `0600` e apagado quando a última
sessão da conta morre (`managed-credentials.ts:693-714`).

**Failover.** O stream do pane é varrido por regex de limite (`orch/limit-detector.ts:94+`); no hit a
conta entra em cooldown e outra é escolhida (`orch/failover.ts:724-812`). O PTY é tratado como
**stream não confiável**: a API do provider pode desmentir o texto (`failover.ts:742-760`) e
quarentena longa exige evidência tipada, não prosa do agente (`:767-786`).

> ⚠️ **DESIGN vs CÓDIGO.** `docs/multi-account-matrix.md:23` afirma que o failover cross-account
> spawna "com resume flags do adapter". **Está desatualizado.** O session id do provider pertence à
> conta, então: **mesma conta** → `--resume` nativo; **conta diferente** → sessão NOVA + continuity
> pack (`failover.ts:52-53`, `src/renderer/orch/failover-controller.ts:58-82`).

### 4.6 F6 — PTY grid + canvas infinito
📄 Completo em **[F6-pty-grid-canvas.md](./F6-pty-grid-canvas.md)** · ✅ verificado por amostragem

**O que faz.** Leva um clique a um shell real e mantém esse shell vivo enquanto o usuário reorganiza
o grid, arrasta o pane no canvas infinito ou alterna entre as duas views.

**Um PTY do Nexus não é `node-pty` direto.** No macOS a cadeia é
`/usr/bin/perl -T` (binário sob SIP, estágio zero) → `nexus-pty-supervisor` (assinado) → CLI real
(`src/main/pty/pty-host-entry.ts:107-127`). O perl autentica as duas imagens do supervisor por ID,
Team ID e CDHash antes de desanexar o trace; o supervisor valida a imagem viva do provider. Contrato
autoritativo em [`../../DARWIN-PTY-SUPERVISOR.md`](../../DARWIN-PTY-SUPERVISOR.md) — não duplicado aqui.

**Onde mora o estado que sobrevive — três camadas distintas** (a resposta direta à pergunta da frente):

| Camada | Onde vive | Sobrevive a |
|--------|-----------|-------------|
| Processo do CLI | utilityProcess `nexus-pty-host` + supervisor nativo | qualquer coisa no renderer, **inclusive reload da janela** |
| Buffer/sessão do xterm | `hosts: Map<string, Host>` **module-level** (`terminal-host.ts:244`, verificado) | remount React, split, close de irmão, troca grid↔canvas |
| Composição (árvore, posições) | Zustand `layout-store` + persistência em disco | fechar o app |

**Por que o pane persiste no reshape.** A árvore de layout só renderiza **slots vazios**; a cada
(re)mount o wrapper React **re-parenteia o MESMO nó DOM** para o novo slot (`terminal-host.ts:56-62`,
`attachHost` em `:1158-1160`). Re-parentear é um *move* no DOM, não uma recriação — por isso
split/close/mover não recriam o terminal. O `Map` ser **module-level** (não estado React) é o que faz
a troca de view custar zero: React desmonta `<PaneGrid/>` e monta `<CanvasView/>` (`App.tsx:588`), mas
o módulo não recarrega.

**Por que grid e canvas compartilham a sessão: eles compartilham a CHAVE.** Não há sincronização
entre as views. O nó do `@xyflow` nasce com `id: pane.id` (`CanvasView.tsx:64`, verificado) e chama o
mesmo `attachHost` (`CanvasPaneNode.tsx:79`); o `PaneLeaf` do grid faz idêntico. Como
`getOrCreateHost` chaveia por `pane.id`, as duas views resolvem para o **mesmo `Host`** — mesmo
xterm, mesmo `sessionId`, mesmo PTY. Zero re-spawn.

**Ordem é garantida; completude é best-effort e visível.** Cada chunk recebe número de sequência e
entra numa janela de replay de 1 MB no main (`pty-manager.ts:751-764`); acima de 512 KB não-ackados o
push é pausado (seguro, porque o replay recupera). Quando o buraco cresce além do orçamento
(4 MB/2048 chunks), o preload **aceita o buraco** e injeta um aviso visível no stream
(`pty-gap-buffer.ts:17-27`). É degradação declarada, não silenciosa.

> 🔴 **DEFEITO ATIVO — reproduzido AO VIVO durante esta auditoria (2026-08-06, ~16:55).**
> Não é histórico nem teoria. No momento da varredura havia **6 `nexus-pty-supervisor` órfãos**
> (`ppid=1`, reparentados ao `launchd`), vivos há **1h18min**, somando **71% de CPU**. O processo
> NexusIDE que os criou estava **morto**, e o diretório de onde rodavam
> (`/private/var/folders/.../nexus-release-e2e-YkBF70/extracted/NexusIDE.app/...`) **já havia sido
> apagado** — executavam a partir de um caminho inexistente. Origem: um E2E de release.
>
> **Causa-raiz confirmada, e o fix nunca foi aplicado.**
> `grep -cE 'PROOF_DEADLINE|NEXUS_EXIT_PROOF_DEGRADED' native/darwin-pty-supervisor/main.c` retorna
> **0** — a "Etapa 1" especificada em
> [`../2026-08-05-pty-supervisor-rust.md`](../2026-08-05-pty-supervisor-rust.md) não entrou no código
> nativo. O `for(;;)` de `main.c:1369`, cuja única saída é `prove_group_empty_twice`, continua
> intacto: inventário `incomplete` mantém o processo vivo **para sempre**. SIGTERM não resolve; só
> SIGKILL.
>
> A única defesa existente é **app-side** — `escalateDarwinSupervisorTermination`
> (`src/main/pty/pty-host-core.ts:323`, escalação SIGTERM→SIGKILL) — e ela **não alcança um supervisor
> que já ficou órfão**, que é exatamente o caso observado. Esta é a lacuna real entre a mitigação
> entregue e o defeito documentado.
> Ressalva de leitura levantada pela F6: `DARWIN-PTY-SUPERVISOR.md:96-97` descreve esse mesmo
> comportamento ("varredura incompleta mantém o supervisor vivo — fail-closed") de um jeito que, lido
> isoladamente, **soa como garantia e não como o defeito que causou os zumbis**.

> ✅ **Lacuna cruzada resolvida.** A F5 não achou consumidor de `spawn.ptyRequired`. A F6 achou:
> `src/main/real-mission-e2e-workspace.ts:333,389`. Verificado que `pty-manager.ts` tem **zero**
> ocorrências — ou seja, o flag é consumido só pelo harness de missão real E2E e é **declarativo no
> caminho de spawn normal**.

---

## 5. Essencial vs incidental (visão de sistema)

Cada frente traz sua própria lista (§4 de cada doc). Aqui está a síntese **de sistema**: o que, se
removido, muda o que o NexusIDE *é* — separado do que é ajuste, herança ou conveniência.

### 5.1 O núcleo irredutível

Se você tivesse que reconstruir o NexusIDE, estes sete mecanismos **são** o produto. Todo o resto é
superfície.

| # | Mecanismo | Onde | Por que é o núcleo |
|---|-----------|------|--------------------|
| 1 | **Session ≠ Pane, com o xterm num `Map` module-level** | `terminal-host.ts:244` | É a persistência inteira. Grid, canvas e reshape só funcionam porque o terminal não é estado React. Trocar isso quebra a feature central. |
| 2 | **Identidade compartilhada por `pane.id`** | `CanvasView.tsx:64` | Grid e canvas não sincronizam — resolvem para o mesmo `Host` pela mesma chave. Sem essa igualdade, seriam sessões distintas e o canvas viraria re-spawn. |
| 3 | **PTY isolado em `utilityProcess` + cadeia perl→supervisor** | `pty-host-client.ts:33-38`; `pty-host-entry.ts:107-127` | Crash do addon nativo não derruba o app; e a cadeia assinada é a fronteira de autoridade sobre processos-filho no macOS. |
| 4 | **Ordem por sequência + ack + janela de replay** | `pty-manager.ts:751-772` | É a única garantia de ordem do stream. O backpressure só é seguro porque o replay existe. |
| 5 | **Mecânica declarativa vs autoridade main-owned** (adapters) | `adapter-registry.ts:94-135`, `:55` | Um JSON no home descreve como spawnar, mas **nunca** se promove. É o que impede escalação de privilégio por arquivo de config. |
| 6 | **`pretool` fail-closed** | `hooks-gen.ts:102-109`; `mcp-server.ts:402-449` | O único ponto de veto de tool/skill no sistema. Sem credencial, stdin inválido ou gate fora do ar ⇒ `exit 2`. |
| 7 | **Invariante activity-only: hook nunca autoriza conclusão** | 3 call sites independentes (F3) | É o que separa "hook reporta" de "hook decide". Hard-coded como literal `false` em triplicata. |

### 5.2 As três fronteiras de segurança que o boot estabelece

Não são features — são pré-condições. O app se recusa a existir sem elas.

1. **Fail-closed em três portões no boot** — protocolo (`main.ts:713-730`), CSP (`window.ts:257-271`),
   bootstrap de IPC (`main.ts:776-789`). Nenhum renderer parcial é jamais exposto.
2. **Superfície única de bridge** — um `exposeInMainWorld` (`preload.ts:1586`) com `contextIsolation`
   e `sandbox` ligados (`window.ts:290-297`) e fuses fechando `RunAsNode`/`NODE_OPTIONS`
   (`forge.config.ts:412-421`). `ipcRenderer` cru nunca cruza.
3. **Segredo cifrado ou nada** — `safeStorage` obrigatório, **falha fechada**, nunca degrada para
   plaintext (`secrets-store.ts:284-286`), e nunca em `argv` (`claude-credential.ts:156-172`).

### 5.3 Incidental — o que pode mudar sem o produto deixar de ser ele

- **Números de ajuste:** `SNAPSHOT_THRESHOLD = 0.45`, pool de 8 leases de WebGL, debounce de resize
  de 60 ms, tetos do gap buffer, `COALESCE_MS`, `REARM_MS`. Políticas de degradação, não protocolo.
- **Heurísticas que crescem com o ecossistema:** a lista curada de diretórios de PATH
  (`path-resolver.ts:72-104`), os quirks por CLI nos JSONs de adapter.
- **Herança de fork (Orca, MIT):** aceitar o header `x-orca-agent-hook-token`
  (`hook-http-server.ts:149`); os 12 alvos de hook declarados sem installer correspondente.
- **Simetria sem efeito:** o `posttool`, que é no-op server-side (`mcp-server.ts:451-453`) e hoje só
  custa um round-trip por tool call.
- **Contornos de versão:** o seed de trust do Codex (≥ 0.129), o slim do blob do Claude (limite de
  ~4 KiB da linha do `security -i`).
- **Instrumentação e diagnóstico:** `traceBootstrap`, CDP via `NEXUS_REMOTE_DEBUG`, espelho de log do
  renderer, diagnóstico de `#root` vazio — todos opt-in e/ou dev-only.
- **Lixo:** o `main.js` da raiz (§3.2) — apagar não afeta nada.

### 5.4 O que é essencial e **ainda assim** está degradado hoje

Honestidade sobre o estado atual, não sobre o design:

- **O Stop-hook não bloqueia mais em HEAD** (commit `5ac0fd58`). `evaluateStop` segue correto, mas
  seu veredito não chega ao cliente. A garantia real migrou para
  `src/main/orch/worker-handoff-enforcement.ts`, que não depende de hook. Ver §4.3.
- **O supervisor nativo tem um caminho de teardown que não termina** — inventário `incomplete`
  mantém o processo vivo indefinidamente, com zumbis observados em campo. Ver §4.6.
- **`--settings` em HOME real não recebe gate** — panes Claude em HOME real e GLM/LongCat recebem só
  os status hooks, nunca o `nexus-gate.mjs` (F3 §3.5).

---

## 6. Auditorias pré-existentes agregadas

Esta auditoria **não reescreve** o material abaixo; agrega e aponta divergências.

| Documento | Frente | Papel |
|-----------|--------|-------|
| [../../ARCHITECTURE.md](../../ARCHITECTURE.md) | F1, todas | design prescritivo 2026-07-03 — hipótese, não prova |
| [../../MCP-HUB.md](../../MCP-HUB.md) | F2 | contrato, ownership e limites do hub |
| [../fase4-mcp-map.md](../fase4-mcp-map.md) | F2 | mapa de tools da fase 4 |
| [../2026-08-05-mcp-hooks-propagation-audit.md](../2026-08-05-mcp-hooks-propagation-audit.md) | F2, F3 | propagação de MCP e hooks |
| [../../orchestration.md](../../orchestration.md) | F4 | orquestração |
| [../../MISSION-EVENTS.md](../../MISSION-EVENTS.md) | F4 | journal de eventos de missão |
| [../../SKILLS.md](../../SKILLS.md) | F4 | vocabulário de skills / skill-gate |
| [../2026-08-04-analise-profunda-orquestracao-panes.md](../2026-08-04-analise-profunda-orquestracao-panes.md) | F4 | análise profunda de orquestração |
| [../2026-07-23-golden-path-orch.md](../2026-07-23-golden-path-orch.md) | F4 | golden path da orquestração |
| [../../adding-a-cli.md](../../adding-a-cli.md) | F5 | como plugar uma CLI |
| [../../multi-account-matrix.md](../../multi-account-matrix.md) | F5 | matriz multi-conta |
| [../../DARWIN-PTY-SUPERVISOR.md](../../DARWIN-PTY-SUPERVISOR.md) | F6 | contrato do supervisor nativo |
| [../2026-08-05-pty-supervisor-rust.md](../2026-08-05-pty-supervisor-rust.md) | F6 | supervisor PTY |
