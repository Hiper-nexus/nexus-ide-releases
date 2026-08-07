# MAPA DO BRIDGE DEFINITIVO — Especificação Canônica Unificada

> **Versão:** 2.0 Definitiva
> **Fontes Reconciliadas:** `bridge-reverse-claude` + `bridge-reverse-swarm` (F1–F6) + Inspeção Direta do Binário 3.4.18
> **Escopo:** Arquitetura do Host, MCP Server, Integration Hooks, Data Schema, Frontend Swarm Orchestrator, UI Components e Plano de Absorção no NexusIDE.

---

## 1. Sumário Executivo & Linha de Produtos

O ecossistema **Bridge** é um shell gráfico multi-agente desktop para macOS desenvolvido pela **BridgeMind, Inc.** (`bridgemind.ai`). A suite combina execução nativa de PTY, hospedagem de servidores MCP locais, isolamento de swarms multi-agentes e ditado de voz integrado.

### Identificação Factual dos Componentes

```
+-------------------------------------------------------------------------+
|                              BRIDGEMIND, INC.                           |
|                         (Marca & Serviços Cloud)                        |
+-------------------------------------------------------------------------+
                                     |
         +---------------------------+---------------------------+
         |                                                       |
+----------------------------------+            +----------------------------------+
|           BRIDGESPACE            |            |           BRIDGEVOICE            |
|       Host Principal (Tauri)     |            |     Satélite STT (Tauri 2.8.2)   |
|        Bundle: 3.4.18 arm64      |            |    Whisper Local + AppleEvents   |
+----------------------------------+            +----------------------------------+
  |-- Subsystem: BridgeMemory (MCP)
  |-- View: Workspace Kanban (Board)
  |-- API: Mobile Bridge (Companion)
```

1. **BridgeSpace (`/Applications/BridgeSpace.app`):** Host Tauri 2.10.3 gordo (binário Rust 33.8 MB `bridgespace-tauri`). Concentra PTYs, terminal xterm.js, orquestração de swarm, browser sidebar, SSH/SFTP, SQLite `history.db` e proxies MCP.
2. **BridgeVoice (`/Applications/BridgeVoice.app`):** App satélite independente (Tauri 2.8.2) que capta áudio (mic), faz transcrição (Whisper local ou Together/Fireworks Cloud) e injeta texto via AppleEvents e Accessibility APIs em qualquer janela ativa.
3. **BridgeMemory:** Subsystem de memória em grafo via arquivos Markdown (`.bridgememory/`) exposto como MCP Server Node (`bridgememory-mcp`). Exige subscrição Pro/Ultra.
4. **Workspace Kanban:** View/feature de board integrada no frontend JS (`KanbanBoard-*.js`). Não existe como aplicativo separado ("BridgeBoard").
5. **Mobile Bridge:** Servidor TCP/HTTP embutido (`mobile_bridge.rs`) que expõe controle do host para dispositivos móveis via chave `x-bridgespace-token`.

**Fontes:** `bridge-reverse-swarm/F1-tauri-ipc.md` §b.1/§b.12;
`F2-bridgememory-mcp.md` §B.1; `F6-produto-ui.md` §B.1.

---

## 2. Arquitetura do Host (Tauri 2.10.3 & Core Rust)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FE: React / Vite App Shell + Web Components Lit Overlay (z-index 100k) │
└─────────────────────────────────────────────────────────────────────────┘
                                   │ IPC (ACL trusted-main: 177 cmds)
┌──────────────────────────────────▼──────────────────────────────────────┐
│ CORE RUST (bridgespace-tauri binary 33.8MB)                             │
│ ├─ PTY Manager (`portable-pty` / xterm backpressure / DPR recovery)      │
│ ├─ SQLite Engine (`history.db` WAL + `refinery` + custom `frecency()`)  │
│ ├─ Native SSH/SFTP (`russh 0.61` async)                                  │
│ ├─ Crypto (`ring`/`rustls` AES-GCM / ChaCha20 / RSA)                     │
│ └─ MCP Config Rewriter (shimming `CLAUDE_CONFIG_DIR` & `CODEX_HOME`)     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Stack & Capabilities IPC

- **Framework:** Tauri 2.10.3 (Rust core + Webview).
- **ACL Capability (`trusted-main`):** Exposição estrita de **177 comandos IPC proprietários**.
- **Plugins Oficiais:** `clipboard-manager`, `dialog`, `http` (reqwest), `notification`, `shell`, `global-shortcut`, `updater`, `deep-link`, `single-instance` + `sentry`.

### 2.2 Subsystems de Baixo Nível no Rust

- **PTY System:** Baseado em `portable_pty` e `openpty`. Suporta recuperação de DPR (Device Pixel Ratio), backpressure monitorado no canal frontend (`frontend-channel-backpressure`, alertas se write > 80ms) e persistência de scrollback.
- **SSH/SFTP System:** Implementado via `russh 0.61` (evitando a CVE-2025-54804 do `thrussh`). Suporta autenticação por agente SSH nativo ou passphrase.
- **SQLite Engine:** Gerencia `~/.bridgespace/history.db` em modo WAL. Usa `refinery` para migrações e registra uma extensão nativa Rust chamada `frecency()` para pontuação de comandos por uso recente e frequência.

**Fontes:** `bridge-reverse-swarm/F1-tauri-ipc.md` §b.2–§b.11;
`F4-dados-runtime.md` §B.1–§B.2. O número de comandos vem da ACL
`trusted-main`; não deve ser confundido com contagem de símbolos soltos.

---

## 3. Hooks e integração com agentes

O Bridge normaliza eventos heterogêneos dos CLIs numa borda pequena e mantém
separados o identificador do terminal/pane e o identificador nativo retomável da
conversa.

- `bs-claude-hook.cjs` trata o ciclo Claude; `bs-agent-notify.cjs` aceita
  formatos de outros agentes e os reduz a estados como `running`, `idle`,
  `needs-input`, `error` e `ended`.
- Fora de swarm, cada evento vira um JSON próprio em dropboxes globais. A escrita
  usa temporário + rename; falhas não derrubam a CLI pai.
- O gate `BRIDGESPACE_SESSION_ID` evita que hooks globais produzam notificações
  para execuções fora de um pane do BridgeSpace.
- No scope de swarm, o hook Claude consegue injetar inbox no
  `user-prompt-submit`, enquanto `bs-mail`/`bs-swarm`/`bs-notify` oferecem uma
  superfície de arquivo independente de uma tool MCP específica.
- A integração de shell emite OSC 133 para fronteiras de prompt/comando/exit e
  OSC 9;9 para o diretório. Loaders preservam os dotfiles do usuário e restauram
  `ZDOTDIR`.

O principal risco observado é de privacidade: um caminho de diagnóstico do hook
Claude pode registrar uma amostra curta do `stdin` bruto quando falha ao extrair
o prompt. Esse detalhe não é um padrão a portar.

**Fontes:** `bridge-reverse-swarm/F3-hooks-agentes.md` §1–§4 e §c;
`F5-swarm-missoes.md` §B.4–§B.7.

---

## 4. Subsystem BridgeMemory MCP

O **BridgeMemory** é um servidor MCP Node.js (`~/.bridgespace/bridgememory-mcp/server.cjs`, v0.2.0) executado estritamente via transporte stdio (`StdioServerTransport`).

### 4.1 Camada de Segurança & Orfanato

- **Runtime Token Gate:** O servidor exige o arquivo `~/.bridgespace/runtime.session` (64 bytes hex). Toda chamada de tool valida o token de ambiente `BRIDGESPACE_RUNTIME_TOKEN` contra o arquivo usando **`constantTimeEquals`** (operação XOR bit-a-bit para imunidade contra ataques de tempo).
- **Orphan Guard:** O servidor possui um loop `setInterval` a cada 30s. Se o `process.ppid === 1` (indicando que o processo pai BridgeSpace caiu e o Node foi herdado pelo `init`), o servidor executa imediatamente `process.exit(0)`, prevenindo processos zumbis na máquina do usuário.

```javascript
// Proteção de Orfanato no server.cjs
setInterval(() => {
  if (process.ppid === 1) {
    process.exit(0);
  }
}, 30000);
```

### 4.2 Formato dos Hubs e Grafo de Conhecimento

- **Identificador de Hub:** Qualquer pasta no sistema contendo a subpasta `.bridgememory/`.
- **Descoberta:** Função `findHubRoot` sobe até **64 níveis** na árvore de diretórios procurando `.bridgememory/`.
- **Formato dos Registros:** Arquivos `.md` simples **sem frontmatter YAML**.
  - O título da memória é obrigatoriamente o primeiro H1 (`# Título`).
  - O Grafo de Conhecimento é formado exclusivamente via **`[[wikilinks]]`** (`[[Nome da Memória]]` ou `[[Nome|Alias]]`).
- **Segurança de Traversal:** O MCP usa `realpath` e `isPathInside` para garantir que symlinks dentro de `.bridgememory` não escapem da raiz do hub.

Persistência e grafo são calculados diretamente dos arquivos. A busca faz scan
por chamada em vez de manter índice; isso reduz migração/corrupção de índice,
mas não é uma estratégia que o Nexus deva copiar sem teto de escala. Erros de
memória ausente incluem sugestões, transformando falha em caminho de
recuperação.

**Fontes:** `bridge-reverse-swarm/F2-bridgememory-mcp.md` §B.1–§B.10 e
§C.1–§C.10.

---

## 5. Dados e runtime local

O estado operacional fora dos scopes se divide entre o SQLite
`~/.bridgespace/history.db` e arquivos versionados/privados de runtime.

| Artefato                            | Papel verificado                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `commands`                          | Uma linha por execução: comando, cwd/root, shell, exit, duração, branch, sessão e redação.                                     |
| `command_stats`                     | Agregado `WITHOUT ROWID` por `(cwd, command)`: frequência, sucesso, dias distintos, first/last use, dismiss e decay.           |
| `agent_sessions`                    | Associação de sessão, workspace, pane, agente, conversa nativa, perfil/config, transcript e estado `active/recoverable/ended`. |
| `denylist_patterns` + `redacted_at` | Duas camadas para impedir ou ocultar captura sensível.                                                                         |
| `meta`                              | Marcadores de manutenção, capturas perdidas e redação.                                                                         |
| `session.alive.v1.json`             | PID, release, heartbeat, atividade, diagnósticos e `expected_exit`, permitindo distinguir saída esperada de crash.             |

O refinery ranqueia sugestões nos escopos cwd → project root → global. O SQL
observado confirma incrementos, sucesso, dismiss, decay, prune e rebuild; a
implementação matemática completa de `frecency()` e seus limiares não ficou
legível.

**Fontes:** `bridge-reverse-swarm/F4-dados-runtime.md` §B.1–§B.4;
`F3-hooks-agentes.md` §4.

---

## 6. Orquestração Swarm (frontend + scopes no filesystem)

A descoberta arquitetural mais importante é que **o estado e a coordenação do
Swarm vivem em módulos frontend e scopes no filesystem**, sobre primitivas do
host.

```
~/.bridgespace/swarms/<scopeId>/
├── agents.json                    # Registro de labels e roles
├── SWARM_BOARD.md                 # Board humano de coordenação
├── prompt-<Label>-<epochMs>.md    # Brief individual por agente
├── bin/                           # bs-mail, bs-swarm e bs-notify
├── inbox/
│   ├── <AgentLabel>/              # Mensagens pendentes e consumíveis
│   └── @operator/                 # Canal do operador
├── transcript/                    # Espelho append-only das mensagens
├── nudges/                        # <Label>.txt; sinal auxiliar de wake
├── plan/
│   └── events/                    # Event log autoritativo de goals/tasks
└── status/
    └── <AgentLabel>.json          # Heartbeat/status do agente
```

### Mecânica de Execução

1. **Sem família de comandos Rust `swarm_*`:** a coordenação observada vive nos
   módulos frontend `swarm*.js` e no scope; o literal `spawnSwarmAgent` aparece
   no binário, portanto “zero ocorrência de swarm” seria uma afirmação forte
   demais.
2. **Runtime JS no Webview:** o módulo `swarm-orchestrator-*.js` inicializa o
   scope em `~/.bridgespace/swarms/<scopeId>/` e watchers acompanham mailbox,
   plano, status e retomada de sessão.
3. **Injeção de Ambiente nos CLIs:** Ao lançar um agente CLI (Claude Code ou Codex), o BridgeSpace injeta:
   - `BRIDGESPACE_SWARM_SCOPE_ID=<scopeId>`
   - `SWARM_AGENT_NAME=<agentName>` (ex: `Architect`, `Builder-1`)
4. **CLIs no PATH:** `bs-mail`, `bs-swarm` e `bs-notify` operam o protocolo do
   scope sem exigir uma tool MCP específica do provider. Hooks complementam a
   integração, mas não são a única superfície de coordenação.

O envio segue a ordem `transcript → inbox → nudge`: o histórico sobrevive ao
consumo destrutivo da inbox e a um kill entre writes. O plano é event-sourced,
com goals e tasks reduzidos de `plan/events/*.json`; tasks carregam owner,
dependências, arquivos e critérios de aceite. Se `bs-notify` não consegue
escrever status, o monitor pode cair para detecção de inatividade.

**Fontes:** `bridge-reverse-swarm/F5-swarm-missoes.md` §B.1–§B.8,
especialmente §B.3–§B.7; `F3-hooks-agentes.md` §3.

---

## 7. UI/UX & Design System ("Luxo por Estrutura")

O acabamento de "luxo" do BridgeSpace deriva de uma separação estrita entre o layout do aplicativo e a camada de overlays e micro-interações.

### 7.1 Web Components Lit Overlay (`z-index: 100000`)

- As interações flutuantes mapeadas (Inspector de DOM, File Picker, Hover
  Labels, modais de contexto e menus de agente) são instanciadas como **Web
  Components Lit** fora da árvore DOM principal de React/xterm.
- **Title-Set IPC Chunking:** Para enviar dados pesados do webview de volta ao Rust sem congelar o IPC principal, o BridgeSpace usa `document.title = '__BRIDGE_PICKER__' + encodedPayload` em chunks.

### 7.2 Motion & Animation Design

- **Easings Curados:**
  - Entrance/Overshoot (personalidade elástica): `cubic-bezier(0.34, 1.56, 0.64, 1)`
  - Exit/Smooth Transition: `cubic-bezier(0.22, 0.8, 0.2, 1)`
- **Reconstrução de handoff builder-to-builder:** hipótese de SVG Path com
  `stroke-dashoffset` entre cards e feedback no destino; não foi observada de
  ponta a ponta.

O overlay, blur, modal de 180 ms e pulse de 2,2 s têm evidência direta nos
chunks/CSS do inspector. Já a geometria builder→builder e o fluxo completo do
Mission Wizard são reconstruções: os assets existem, mas a interação não foi
observada visualmente de ponta a ponta.

**Fontes:** `bridge-reverse-swarm/F6-produto-ui.md` §B.2–§B.5;
`bridge-reverse-claude/DESIGN_SYSTEM_BRIDGE.md` §3–§5, com as lacunas desse
próprio documento preservadas.

---

## 8. Cruzamento com o NexusIDE

O cruzamento atualizado e verificado contra o código atual está em
[`NEXUS_X_BRIDGE.md`](./NEXUS_X_BRIDGE.md). Ele substitui o plano de absorção
anterior desta seção.

A tabela **Estado de implementação na 0.28.1** desse documento separa o que já
foi entregue do que continua como plano. Os itens abaixo preservam a decisão
arquitetural original e não devem ser lidos, isoladamente, como backlog atual.

Resumo da decisão:

- **Não substituir o runtime do Nexus por filesystem scopes.** SQLite, receipts,
  ACK físico, hash chain, effect policy e worktrees continuam autoritativos.
- **Adicionar uma projeção legível por missão** (`BOARD.md`, status, eventos e
  transcript de handoffs) derivada do runtime canônico.
- **Adicionar shims capability-scoped no PATH** (`nx-mail`, `nx-task`,
  `nx-notify`) como via de entrega independente de MCP/hooks; o Main valida e
  persiste no journal existente.
- **Aceitar Markdown humano como entrada de memória com CAS**, mantendo
  SQLite/FTS5, audit e dedupe.
- **Construir command refinery** sobre os CommandBlocks já capturados.
- **Simplificar o wizard existente**, sem criar um segundo wizard paralelo.
- **Adaptar continuidade espacial de handoff** aos portals, tokens, ladder de
  z-index e motion já definidos no `DESIGN.md`; não copiar `z-index: 100000` ou
  spring elástico.

Correções de estado atual importantes:

- o TTL pós-handoff está default-on em `src/shared/feature-flags.ts`;
- silêncio de worker já tem nudge + handoff sintético em
  `worker-handoff-enforcement.ts`;
- o planner já suporta writers disjuntos em worktrees;
- missões bloqueadas possuem recuperação/reopen Main-owned.

As travas residuais são de **legibilidade**, **independência de canal**,
**degradação dos gates por tier** e **descoberta/UX**, não ausência do motor de
orquestração.

---

## 9. Evidência e lacunas preservadas

Escala usada neste mapa:

- **Verificado:** arquivo, schema, ACL, asset, script ou estado vivo observado.
- **Inferido:** comportamento sustentado por nomes/SQL/comentários, sem corpo
  completo da implementação.
- **Reconstruído:** direção de produto/visual que ainda exige observação runtime.

Lacunas que continuam abertas:

- fluxo e copy exatos do Mission Wizard;
- fórmula nativa completa de `frecency()` e limiares de manutenção;
- semântica/rotação completa de `runtime.session` e `bridgememory.active`;
- consumidor interno completo de todos os watchers e primitiva final de wake;
- comportamento de múltiplos swarms concorrentes;
- app mobile companion, além do lado host;
- tokens visuais completos e handoff builder→builder observado em vídeo.

Documentos de evidência primária: `bridge-reverse-swarm/F1-tauri-ipc.md` a
`F6-produto-ui.md`. A análise Claude é usada para hipóteses de composição e para
o inventário inicial; conflitos factuais são resolvidos pelo artefato vivo ou
pelas frentes F1–F6.
