# COMPARATIVO — Engenharia Reversa do Bridge (Claude vs. Swarm)

> **Documento de Reconciliação Canônica**
> **Objetivo:** Confrontar as duas investigações independentes do app **Bridge** (BridgeSpace / BridgeMind), resolver divergências com evidências empíricas extraídas do binário macOS 3.4.18 e determinar a síntese definitiva para absorção no NexusIDE.
> **Data de Reconciliação:** 2026-08-06

---

## 1. Tabela de Confronto Diretamente Lado-a-Lado

| Dimensão                        | Versão Claude (`bridge-reverse-claude`)                                                                         | Versão Swarm (`bridge-reverse-swarm`)                                               | Resolução & Evidência Canônica                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Versão do Tauri**             | Identificou como **Tauri 2.8.3**                                                                                | Identificou como **Tauri 2.10.3**                                                   | **Tauri 2.10.3** (Vitória do Swarm). Evidência empírica no Mach-O `/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri`: caminho da Cargo registry `/Users/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.10.3/src/plugin.rs` e `tauri-plugin-updater/2.10.1`. Claude citou 2.8.3 baseado na versão do satélite BridgeVoice (2.8.2) ou declaração genérica de dependência. |
| **Padrão ID `swarm-pane-*`**    | Trata `swarm-pane-*` como IDs reais encontrados no `history.db`                                                 | Afirma 0 hits para `swarm-pane-*` no binário Rust (`nm`/`strings`)                  | **Reconciliado (camadas diferentes).** Há dado runtime atribuído a panes de swarm no `history.db`, enquanto o literal fixo não foi encontrado estaticamente no binário. O mecanismo exato que formata o ID não foi isolado e permanece lacuna.                                                                                                                                                             |
| **Existência do "BridgeBoard"** | Cogitou ser app / workspace tipo kanban / produto separado                                                      | Afirmou 0 hits para "BridgeBoard" no binário/filesystem                             | **Feature Kanban interna (Vitória do Swarm).** Não existe binário `BridgeBoard.app` ou símbolo Rust `BridgeBoard`. O chunk do frontend é `/assets/KanbanBoard-C40V2t93.js`. Trata-se de uma _workspace view_ (Kanban) dentro do BridgeSpace host, não um produto isolado.                                                                                                                                  |
| **Localização do Swarm Logic**  | Descreveu orquestração Swarm integrada no app host                                                              | Identificou a coordenação como **frontend / scope-based**                           | **Estado e coordenação no frontend (evidência mais forte do Swarm).** Não foi encontrada uma família Rust IPC `swarm_*`; módulos `swarm*.js` operam arquivos em `~/.bridgespace/swarms/<scopeId>/`. O literal `spawnSwarmAgent` também aparece no binário, então isso não prova que toda primitiva de spawn seja frontend-only.                                                                            |
| **Design System & Overlay**     | Reconstruiu overlay Lit (`__bridge_*`), motion, z-index e um possível fluxo de wizard a partir de assets/chunks | Mapeou fragmentos CSS do inspector (slate/blue/violet, blur 16px)                   | **Boa hipótese de produto, evidência visual parcial.** A separação estrutural dos overlays e a continuidade do handoff são aproveitáveis; valores, motion e fluxo exato precisam de validação visual e adaptação ao `DESIGN.md` do Nexus.                                                                                                                                                                  |
| **Segurança & Gate MCP**        | Documentou `runtime.session` e SDK stdio                                                                        | Provou uso de `constantTimeEquals` (XOR anti-timing) e `orphanGuard` (30s interval) | **Detalhamento Interno Superior (Vitória do Swarm).** Swarm abriu o `server.cjs` linha a linha (`:21062-21069`), comprovando proteção contra timing attacks na chave de 64 bytes.                                                                                                                                                                                                                          |
| **Superfície IPC & ACL**        | Mapeou domínios de alto nível (PTY, Memory, Swarm, Auth)                                                        | Mapeou os **177 comandos IPC exatos** sob a capability `trusted-main`               | **Precisão Auditável Superior (Vitória do Swarm).** Swarm extraiu a concatenação inteira da ACL Tauri e filtrou pools internados.                                                                                                                                                                                                                                                                          |

---

## 2. Acordos Fundamentais (Consenso entre ambas as fontes)

1. **Host Concentrador (BridgeSpace):** O app real é o **BridgeSpace 3.4.18** (`io.bridgemind.bridgespace`). BridgeMind é a razão social/marca cloud (`bridgemind.ai`), BridgeVoice é o app satélite STT (`com.bridgemind.bridgevoice`), e BridgeMemory é um subsystem MCP local.
2. **Local-First & Non-Intrusive:** O estado vive em Markdown e SQLite (`history.db` modo WAL com migrações `refinery`). Os agentes nativos (Claude Code, Codex) mantêm seus transcripts no filesystem original; o BridgeSpace reescreve a config MCP (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) para injetar o proxy MCP local sem adulterar os executáveis.
3. **Shell Integration via OSC:** Captura de prompts/comandos via **OSC 133** e diretório de trabalho via **OSC 9;9**, usando override de `ZDOTDIR` para isolar do `.zshrc` do usuário.
4. **BridgeMemory Hub Design:** Hubs demarcados pela pasta `.bridgememory/`. Arquivos `.md` sem frontmatter YAML (primeiro H1 é o título). Conexões feitas exclusivamente via `[[wikilinks]]`.
5. **Autonomia do Satélite Voice:** O BridgeVoice 2.8.2 roda em background como LaunchAgent, faz Whisper/Parakeet local + Together/Fireworks cloud, e digita em qualquer app via AppleEvents + Accessibility API.

---

## 3. Forças Únicas e Lacunas de Cada Análise

### A) Versão Claude (`bridge-reverse-claude`)

- **Forças Únicas:**
  - **Foco em Produto e UX:** Traduziu a arquitetura em lições práticas de UI/UX, explicando por que o app aparenta ser "premium".
  - **Hipótese de Design Reconstruída:** Isolou indícios de tipografia
    system-first, tokens semânticos, overlay Lit, z-index alto e animação
    elástica; os valores não equivalem a uma especificação visual validada.
  - **Blueprint do Mission Wizard:** Reconstruiu o fluxo de 3 passos para criação de missões multi-agentes com mentions `@` para context files.
  - **Identificação do Hack Title-Set IPC:** Descobriu que payloads gigantes do browser-sidebar usam `document.title = '__BRIDGE_*__'` para burlar limites de IPC webview.
- **Lacunas:**
  - Versão do Tauri desatualizada (2.8.3 em vez de 2.10.3).
  - Supôs que a orquestração do Swarm requeria handlers nativos no Rust (desmentido pelo binário).
  - Tratou o BridgeBoard com indefinição entre produto/workspace.
  - Reconstrução visual sem comparação runtime suficiente para declarar tokens,
    motion ou fluxo exatos como canônicos.

### B) Versão Swarm (`bridge-reverse-swarm`)

- **Forças Únicas:**
  - **Auditoria de Baixo Nível Impecável:** Verificação byte-a-byte no binário via `nm -a`, `strings -a -n 6` e parsing de segmentos Mach-O.
  - **Descoberta do Swarm Scope-Based:** Demonstrou que estado, mailbox, plano e
    watchers vivem em scopes de arquivo coordenados por módulos frontend, sem
    uma família dedicada de comandos Rust `swarm_*` observada.
  - **Mapeamento Exato da ACL Tauri:** Identificação dos 177 comandos IPC nativos na capability `trusted-main`.
  - **Análise do Security Boundary do MCP:** Detalhou o `constantTimeEquals` no `server.cjs` e a rotina `orphanGuard` que encerra o processo Node se o PPID virar 1.
  - **Frecency Engine no SQLite:** Identificou o registro da função escalar `frecency` dentro do SQLite via extensão Rust.
- **Lacunas:**
  - Baixa extração de tokens visuais e princípios de Motion (foco predominantemente em backend/IPC).
  - Não explorou a experiência do usuário nem o blueprint de implementação no NexusIDE.

---

## 4. Veredito Final de Reconciliação

**O corpo técnico mais forte resulta da FUSÃO SINTÉTICA dos dois trabalhos:**

- **Backend / IPC / Segurança / Swarm Architecture:** a análise do **Swarm** tem
  a evidência canônica mais forte. O scope de filesystem e a coordenação nos
  módulos frontend, junto da enumeração do Tauri 2.10.3, corrigem as premissas
  anteriores; primitivas genéricas do host continuam fora dessa conclusão.
- **Frontend / Design System / Motion / UX Pipeline:** a análise do **Claude**
  fornece uma referência de produto útil, não autoridade visual. O Nexus deve
  herdar a separação estrutural de overlays, a clareza do caminho e a
  continuidade espacial, mantendo tokens, ladder e motion do próprio
  `DESIGN.md`.

Juntas, elas compõem a especificação definitiva apresentada nos documentos `MAPA_DO_BRIDGE_DEFINITIVO.md` e `DESIGN_SYSTEM_BRIDGE_DEFINITIVO.md`.

> O cruzamento contra o **código atual** do NexusIDE, incluindo correções a gaps
> já fechados e a ordem manter/herdar/corrigir, está em
> [`NEXUS_X_BRIDGE.md`](./NEXUS_X_BRIDGE.md). As referências visuais do Bridge
> não substituem o `DESIGN.md` do Nexus.
