# Dossiê — Extração total BridgeSpace 3.4.18

**Data:** 2026-09-03 · **Alvo:** BridgeSpace 3.4.18 (Tauri) + BridgeMindOne + harness `~/.bridgespace`
**Método:** mesma doutrina do dossiê Overclock 1.3.18 — evidência preservada, sondas
offline, extração reproduzível por script.

---

## 1. Fontes primárias

| Fonte | Caminho | O que rendeu |
|-------|---------|--------------|
| Binário Tauri | `/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri` (Mach-O arm64, 33.784.928 B, sha256 `fd82eaac…42d1691`) | Frontend completo embutido: 90 assets Vite + index.html + auth-success.html + 59 streams brotli brutos + 154 comandos Tauri |
| Binário nativo | `/Applications/BridgeMind.app/Contents/MacOS/BridgeMindOne` (universal, 35.204.832 B, sha256 `748c4d98…b4be94b`) | BridgeMindOne app de chat (Swift + bundle de skills/plugins) |
| Harness runtime | `~/.bridgespace/` | bridgememory-mcp (22k linhas), hooks Claude/agent, shell-integration zsh/bash/pwsh, swarms, skills, history.db |
| App Support | `~/Library/Application Support/{io.bridgemind.bridgespace,BridgeMindOne,ai.bridgemind.one}` | auth (enc), session.alive, mobile-bridge, chats.sqlite3, PostHog |
| WebKit | `~/Library/WebKit/io.bridgemind.bridgespace` | origin `tauri://localhost`, localStorage com estado runtime |
| Webapp | `app.bridgemind.ai` (Cloudflare) | secundária — não necessária; tudo veio do binário+disco |

## 2. Estrutura do extract

```
bridgespace-3418-extract/
├── frontend/      90 assets Vite (nomes reais) + index.html + auth-success.html
│                  + manifest.json (sha256_12 validado: 0 divergências)
│                  + inventory-brotli.json + _brotli/ (59 streams brutos)
│                  + tauri-commands.txt (154 comandos IPC)
├── harness/       ~/.bridgespace completo (331 arquivos) + App Support
├── mcp/           bridgememory-mcp/server.cjs + SKILL.md + SURFACE.md
├── schemas/       SQLite dumps (history.db, chats.sqlite3) + sessions/configs
├── visual/        18 capturas de tela runtime (temas, abas, settings)
├── binaries/      sha256 + tamanhos dos binários
├── scripts/       20 scripts de extração reproduzíveis
├── DESIGN-TOKENS.md
└── MANIFEST.md
```

Tamanho total: ~44 MB (frontend 9.7M, visual 30M, harness 3.5M, mcp 760K, schemas 84K).

## 3. Descobertas P0 — Design system (o "visual surreal")

Extraído de 6 CSS + auth-success.html + capturas runtime:

- **Fundo**: `#0c0e14` (dark padrão) / `#0a0a0a` (auth) — preto-azulado, não preto puro
- **Acento primário**: violeta `rgb(167 139 250)` (`--bc-accent-rgb`), forte `#8b5cf6`;
  tema rosado claro no modo light (captura 03: sidebar `#FAEFF5`, seleção `#EDEBFB`,
  acento índigo `#4F46E5`, foco do pane magenta `#EC0F8C`)
- **Marca**: logo quadrantes — TL ouro `#FFD24A→#F6B000`, BR azul `#3B9BFF→#0060B0`,
  TR/BL quase-preto `#1A1A1A→#0E0E0E`, stroke `rgba(255,255,255,.06)`
- **Cores de agente**: builder `#22d3ee`, coordinator `#3b82f6`, reviewer `#eab308`,
  scout `#22c55e`
- **Bordas**: `#252a36` / hover `#30384a` / active `#3b82f6a6`
- **Raio**: card 16px (`--bc-radius-card`), glass 20px (auth)
- **Sombras** (3 níveis): `--bc-shadow-rest` / `--bc-shadow-focus` / `--bc-shadow-drag`
  (multi-camadas, inset 1px top-light + profundidade preta)
- **Blur**: 8/12/24/40/64px (`--blur-sm..3xl`)
- **Vidro**: `rgba(255,255,255,.04)` + border `.06` + backdrop-filter blur(24px)
- **Tipografia**: Inter + -apple-system/BlinkMacSystemFont/Roboto; mono para terminal
- **Easing**: `cubic-bezier(.34,1.56,.64,1)` (spring overshoot), `.4,0,.6,1` (pulse)
- **Tema Dracula** (default) + tema claro rosado + suporte `color-mix(in srgb, …)`
- 315 CSS custom properties mapeadas em `DESIGN-TOKENS.md`

## 4. Descobertas P0 — Superfície IPC (154 comandos Tauri)

Grupos: `terminal_*` (create/attach/write/resize/scrollback/elevated), `ssh_*`
(connect/profiles/keys/passphrase/upload), `fs_*` (sandboxed file ops + watch),
`git_*` (commit/worktree/discover/diff), `mcp_*` (registry/import/sync/verify),
`swarm_*`, `mobile_bridge_*`, `browser_sidebar_*`, `auth_*`, `bridgememory_*`,
`webview_*`, `update_task`, `workspace_*`, `skill_id`, `agent_message`,
`agent_usage_get`, `check_command_exists`, `detect_available_shells`,
`crash_sentinel_*`, `terminal_assist_ghost_*`.
Lista completa em `frontend/tauri-commands.txt`.

## 5. Descobertas P0 — MCP & harness

- **BridgeMemory MCP** (`~/.bridgespace/bridgememory-mcp/server.cjs`, 22.013 linhas):
  12 ferramentas — `hub_status, list_memories, read_memory, search_memories,
  find_backlinks, create_memory, append_to_memory, update_memory,
  suggest_connections, list_orphans, init_hub, delete_memory` (+ `createTask`
  experimental). Hub = `.bridgememory/` com notas markdown `[[wikilink]]`.
  Detalhes em `mcp/SURFACE.md`.
- **Hooks**: `bin/bs-claude-hook.cjs` (312), `bin/bs-agent-notify.cjs` (545),
  `claude-hooks/`, `agent-hooks/`
- **Shell integration**: zsh/bash/pwsh (`.zshrc`, `.zprofile`, `bashrc`,
  `integration.zsh`, `profile.ps1`, …)
- **swarms/**, **skills/** — orquestração multi-agente e skills de prompt

## 6. Descobertas P1 — Dados & schemas

- `history.db` (SQLite): `commands` (com cwd/git_branch/exit_code/duration,
  indexes de prefixo, redaction), `agent_sessions`, `denylist_patterns`, `meta`,
  `refinery_schema_history` → schema em `schemas/history.db.schema.sql`
- `BridgeMindOne/chats.sqlite3`: `chat_threads(id, updated_at, payload BLOB)`,
  `archive_metadata` → `schemas/bridgemindone/chats.schema.sql`
- Sessões: `session.alive.v1.json`, `session.json`, `archived-chats.json`,
  `notifications.json`, `mobile-bridge-config.json`
- WebKit localStorage (24 chaves): tema dracula, `jarvis-config.v1`,
  `workspace-snapshot`, `terminal-titles.v1` (20KB), `swarm-snapshot`, zoom,
  sidebar state, floating bridge pos
- Auth: `auth_credentials.enc` + `auth_storage.key` (estrutura preservada,
  conteúdo sensível não extraído)

## 7. Descobertas P2 — Modelos ONNX = pipeline de VOZ local (RESOLVIDO)

Os streams `_brotli/` .txt são assets da família `/models/` com paths **reais na
tabela embutida do tauri-codegen** (strings no binário, offset ~21.097.317):

| Path embutido | Stream provável | Papel |
|---------------|-----------------|-------|
| `/models/hey-mycroft.onnx` | 031 (857KB, protobuf "pytorch 1.12.1", `onnx::Flatten`/`onnx::Gemm` — MLP puro) | **wake word "Hey Mycroft"** (nomes canônicos do projeto openWakeWord) |
| `/models/melspectrogram.onnx` | 055/035 (773KB/825KB) | mel-spectrogram de pré-processamento de áudio |
| `/models/embedding_model.onnx` | — | embedding local (busca semântica) |

- **Quem roda**: lado Rust nativo. Stack de áudio confirmada por cargo paths:
  `cpal-0.15.3` + `coreaudio-rs-0.11.3` (captura). Strings de runtime ligam ao
  companion: "Consumed BridgeVoice injection", "bridge_agent_voice_cancel task
  failed", sync do `bridgevoice-inject-token`.
- **Como roda**: **nenhum crate de runtime ONNX** no binário (sem ort/tract/ndarray
  em 194 crates — lista em `frontend/rust-crates.txt`) → inferência é código
  próprio; os modelos são MLPs Flatten+Gemm, triviais de avaliar à mão.
- **Ghost text do terminal NÃO usa ONNX**: duas fontes no SimpleTerminal —
  `fetcher` (LLM remoto via `api.bridgemind.ai`, debounce 400ms, minChars 3) e
  `localFetcher` (top-K de histórico local, minChars 1, limite 5). Telemetria
  `terminal_assist_ghost_{shown,accepted,dismissed}` com `source` do ghost.
- Streams 032-038/056-059 (.txt) = payloads adicionais do mesmo modelo/pesos.
- Bônus da caça: strings de **ACL/capabilities Tauri** completas (allow/deny de
  webview, window, global-shortcut, http fetch, notification, clipboard) e
  `ml-kem-0.3.2` (criptografia pós-quântica no stack).

## 8. Descobertas P3 — Notas de engenharia

- BridgeSpace é **Tauri (Rust + WKWebView)**, não Electron — sem asar; assets
  embutidos no binário no formato `[path][brotli data]` (89/90 descomprimem com
  zlib.brotli; 1 stream delimitado por fallback de varredura)
- O blob usa **mix de assets brotli e não-comprimidos** (tauri-codegen decide por
  asset; MainApp 1.1MB está plaintext)
- `index.html` real = entry Vite refs `index-D0sLjlYW.js` + `index-D74TX2y4.css`
- `auth-success.html` = página pós-OAuth "You're signed in" (tokens de marca)
- origin WebKit = `tauri://localhost` (frontend 100% local)
- Sentry 10.8.0 embutido (release `bridgespace@3.4.18`)
- BridgeVoice fora do escopo (anotado como segunda passada opcional)

## 9. Nota de licença

BridgeMind é produto comercial fechado. Este extract é para estudo privado e
portabilidade pelo dono da licença. Ao portar para o Nexus: reinterpretar os
tokens (não copiar assets verbatim), manter compatibilidade de contrato apenas
onde o usuário é dono dos dados (harness, history.db, MCPs do usuário).
