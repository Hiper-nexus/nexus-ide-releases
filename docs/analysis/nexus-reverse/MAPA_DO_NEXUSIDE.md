# MAPA DO NEXUSIDE — engenharia reversa de dentro para fora

> **Documento-mestre.** Consolida as 6 frentes de auditoria do NexusIDE.
> **Objetivo:** entender COMO o sistema funciona por dentro **sem ler o código**.
> **Versão auditada:** `nexus-ide` 0.27.0 (`package.json:2-4`)
> **Data:** 2026-08-06 · **Método:** leitura read-only do código + consolidação das auditorias existentes em `docs/analysis/`
> **Status:** 🚧 EM CONSOLIDAÇÃO — frentes F1–F6 em produção pelos donos; este documento agrega conforme cada uma aterrissa.

---

## Como ler este documento

Cada afirmação técnica aponta para `caminho/arquivo.ts:linha`. Onde a verificação não foi possível
dentro do tempo da auditoria, a linha está marcada como `lacuna: <o que falta verificar>` e replicada
na §2 (Lacunas consolidadas). **Nenhuma afirmação sem fonte** — se não tem `arquivo:linha`, é lacuna.

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

> Preenchido na consolidação final a partir da §5 de cada frente.

🚧 _Aguardando aterrissagem de F1–F6._

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
🚧 _Aguardando `F2-mcp-hub.md`._

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
🚧 _Aguardando `F4-orquestracao.md`._

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
🚧 _Aguardando `F6-pty-grid-canvas.md`._

---

## 5. Essencial vs incidental (visão de sistema)

🚧 _Consolidado na entrega final a partir da §4 de cada frente._

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
