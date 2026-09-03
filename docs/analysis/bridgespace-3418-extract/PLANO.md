# PLANO T1–T10 — Portabilidade BridgeSpace → NexusIDE

**Data:** 2026-09-03 · **Executor:** qualquer LLM/sessão futura · **Pré-requisito de leitura:**
`DOSSIE.md` (visão geral), `DOSSIE-HARNESS.md` (harness detalhado — a seção §5 dele
numera P0/P1/P2 que este plano expande), `DESIGN-TOKENS.md` (315 propriedades).

**Doutrina:** o alvo é "funcionalidades e visual deles com DNA do Nexus". Isso significa:
**herdar a arquitetura dos sistemas** (escala de sombras, blur, easings, envelope de
eventos, event-sourcing, gate de MCP) e **reescrever os valores** com a identidade do
Nexus. Assets verbatim (fontes, ícones, logos, modelos .onnx) **não shipam** — ver nota
de licença no fim de cada task quando aplica.

**Ordem sugerida:** T1→T2 (visual), T6→T5→T4→T3 (linha do agente: hooks → shell →
histórico → ghost), T8 (memória), T7 (swarm, depois de T6), T9 (voz, pesado), T10
(transversal). T6 e T8 são independentes e podem ir primeiro.

---

## T1 — Camada de design tokens (fundação visual)

**Evidência:** `DESIGN-TOKENS.md`, `frontend/assets__index-*.css`, `frontend/auth-success.html`

Portar a **arquitetura** do sistema de tokens, não os valores:

1. Criar `tokens.css` no renderer do Nexus com os mesmos *grupos semânticos*:
   - Cor semântica: `--background`, `--border` (+hover/active), `--accent-rgb` como
     triplet RGB (permite `rgb(var(--nx-accent-rgb) / .2)` sem `color-mix` em todo lugar)
   - **Sombras em 3 níveis com papel** (`rest`/`focus`/`drag`): cada nível é multi-camada
     com `inset 0 1px 0 0 <luz-topo>` + 2 camadas de profundidade preta — é isso que dá
     o "surreal" de profundidade, não o valor hex
   - **Escala de blur** (`sm..3xl`: 8/12/24/40/64px) e **vidro** (`rgba(255,255,255,.04)`
     + border `.06` + `backdrop-filter`)
   - **Raio com papel**: card 16px, glass 20px — nunca raio uniforme
   - Easings: spring overshoot `cubic-bezier(.34,1.56,.64,1)` para entradas, pulse
     `.4,0,.6,1` para estados vivos
   - Cores por **papel de agente** (builder/coordinator/reviewer/scout) — o Nexus já tem
     roster, mapear para as funções do nosso squad
2. Valores: manter a paleta do Nexus onde ela existe; onde não existe, decidir
   conscientemente (fundo do app: eles usam `#0c0e14` preto-azulado, não `#000`).
3. Tema claro + escuro desde o início (eles têm dracula default + rosado claro com
   acento índigo `#4F46E5` e foco magenta `#EC0F8C` — o learn é: **o acento muda por
   tema**, não só o fundo).

**Aceite:** tokens.css commitado; 2 telas-chave do Nexus redesenhadas usando só tokens
(sem hex hardcoded); teste visual light+dark.

## T2 — Linguagem de componentes glass/depth

**Evidência:** `visual/03-*.png`, `visual/10-*.png`, `visual/11-*.png`, `frontend/auth-success.html`

1. SurfaceCard glass: fundo translúcido + borda 1px rgba + blur 24px + sombra `rest`;
   hover eleva para `focus`, drag usa `drag`.
2. Modais/overlays com halo radial de marca (2 blobs blur(120px) opacity .35 sobre o
   fundo — usar a cor de acento do NEXUS, não a deles).
3. Motion: entradas com spring overshoot (scale .96→1), saídas rápidas 150ms; estados
   de sucesso com halo pulsante 2s (referência: auth-success).
4. Grid de fundo com dots (`--bc-grid-dot`: `color-mix(text-muted 24%, transparent)`).

**Aceite:** componentes card/modal/overlay do renderer usam os níveis de sombra/blur
de T1; screenshots antes/depois no PR.

## T3 — Terminal ghost assist (duas camadas)

**Evidência:** `frontend/assets__SimpleTerminal-M-KTTCPg.js` (classe do ghost:
overlay inline, `setGhost(prefix, tail)`, invalidação por
`buffer_diverged_from_prefix`), `frontend/assets__SimpleTerminalPane-3eQKrQMy.js`
(fetchers), telemetria `terminal_assist_ghost_{shown,accepted,dismissed}` com `source`

O desenho deles (portar o desenho, não o código):

1. **Camada local** (rápida, offline): top-K de histórico por prefixo com contexto de
   cwd/shell/os/git-branch; `minChars:1`, `limit:5`; invalida quando o buffer diverge
   do prefixo.
2. **Camada LLM** (remota): fetch com **debounce 400ms**, `minChars:3`, cache LRU
   keyed pelo request normalizado; resposta `{prefix, tail, fullCommand, reason}` —
   só aplica se o buffer ainda começa com `prefix`.
3. **UI**: overlay absoluto sobre o terminal, `aria-hidden`, cor herdada, hint badge
   `→`; aceito com seta-direita (`writeToPty(tail)` + ingest no buffer); dismissed
   por qualquer tecla divergente.
4. **Telemetria**: shown/accepted/dismissed com `source` (`local-*` vs LLM),
   `latency_ms`, `partial_len`, `reason` de invalidação — é o que permite tunar.
5. Sanitizar tail antes de escrever no PTY (eles têm `tail_sanitized_to_empty`).

Depende de T4 (histórico) e herda o PTY do Nexus (`src/main/pty/`).

## T4 — Command refinery (histórico que aprende e esquece)

**Evidência:** `schemas/history.db.schema.sql`, DOSSIE-HARNESS §4/§5-P2-7

Tabela `commands` (command/cwd/shell/exit_code/duration/git_branch/session_id) +
`command_stats` com **decay + dismiss + distinct_days** (frecency que esquece) +
`denylist_patterns` (globs) + `redacted_at` com **índices parciais `WHERE redacted_at
IS NULL`** (redigido sai da busca sem apagar a linha). Implementar no SQLite do Nexus
com migração própria; servir T3 e o autocomplete de comando.

## T5 — Shell integration via ZDOTDIR (OSC 133 + OSC 9;9)

**Evidência:** `harness/app-support/io.bridgemind.bridgespace/shell-integration/`
(`.zshenv/.zprofile/.zshrc/bashrc/integration.zsh/integration.bash/profile.ps1`)

Loader reversível: ZDOTDIR aponta para dir nosso que primeiro carrega o ambiente real
do usuário (`__NX_ORIG_ZDOTDIR`, `/etc/zprofile` para path_helper, gate fast-shell
para não-login), depois injeta OSC 133 (blocos prompt/comando/saída/exit) e OSC 9;9
(cwd a cada precmd). No Nexus: consumir no pty-manager para blocos semânticos no
terminal e cwd tracking confiável (alimenta T3/T4).

## T6 — Hook drop-box + envelope canônico + dois namespaces de sessão

**Evidência:** `harness/dot-bridgespace/bin/bs-claude-hook.cjs` (312 l.),
`bs-agent-notify.cjs` (545 l.), DOSSIE-HARNESS §1 (leitura completa antes de
implementar) e §5-P0-1/P0-2

1. Hooks nos CLIs (Claude/Codex/Grok…) escrevem **1 arquivo JSON por evento** em
   `~/.nexus/agent-hooks/global/` com **tmp+rename** (eventos back-to-back não se
   sobrescrevem); main process faz `fs.watch` e roteia por sessionId do pane.
2. Envelope canônico: `sessionId` (pane), `status` (`running|idle|needs-input|error|
   ended`), `event`, `userPrompt` (truncado 4KB), `nativeSessionId`, `transcriptPath`,
   `configDir`, `agentType`, `pid`, `timestamp`.
3. **Dois namespaces**: pane id ≠ conversation id; persistir por pane
   `nativeSessionId`/`configDir`/`transcriptPath`/`resume_command` (modelo:
   `agent_sessions` deles) → "retomar sessão" pós-crash (`claude --resume <id>` sob o
   configDir certo).
4. Gate de posse: sem `NEXUS_SESSION_ID` no env do spawn, hook sai `exit 0` — não
   notificar agentes de outros IDEs.
5. Regra de ouro: **hook nunca falha o processo pai**; todo erro engolido.
   ⚠️ NÃO portar o bug deles: logar stdin bruto (200 chars de prompt) em arquivo de
   debug (§1.1 risco).

**Aceite:** missão com worker Claude reporta needs-input/idle no painel sem parsing
de stdout; resume funciona após restart do app.

## T7 — Swarm = scope dir + plano event-sourced + mailbox transcript-first

**Evidência:** `harness/dot-bridgespace/swarms/1182a86f584ad1/` (swarm REAL completo:
board, agents.json, prompts por role, 83 eventos, 33 transcripts),
`bin/bs-swarm.cjs` (323 l.), `bs-mail.cjs` (200 l.), `bs-notify.cjs` (36 l.),
DOSSIE-HARNESS §3 + §5-P1-4

1. Sem arquivo de estado: `readState() = reduce(eventos append-only, flag wx)` sobre
   `plan/events/*.json`; goals e tasks com `ownedFiles` (≤40, disjuntos),
   `acceptanceCriteria`, `dependsOn`.
2. Mailbox: escrever no **transcript imutável ANTES** das inboxes destrutivas
   (anti-perda); nudge (`nudges/<agente>.txt`) acorda o pane via injeção no PTY.
3. Prompts por role com: scope-freeze ("o breakdown É a missão"), distribuição
   round-robin imediata ("builder ocioso é wall-clock desperdiçado"), escalonamento
   com teto de 2 rodadas de fix, anti-loop (regras 10-12: nada de social chatter,
   inbox vazia = IDLE, parar após swarm_complete), resposta ao operador sempre por
   mail ("output de terminal é invisível").
4. **Correção obrigatória sobre o original**: a escalation real de B2
   (`transcript/1786047877690`) mostra o watcher acordando agente sem mensagem nova —
   no Nexus, acordar **somente com inbox não-vazia nova**.
5. No Electron, watcher/spawn no main process (eles fazem no renderer) — dá pra ter
   locks e single-writer.

Depende de T6 (mesma infra de sessão/spawn).

## T8 — BridgeMemory → MCP próprio ("nexusmemory")

**Evidência:** `mcp/bridgememory-mcp/server.cjs` (código próprio nas linhas
21015–22013), `mcp/SURFACE.md`, `mcp/BRIDGEMEMORY-SKILL.md`, DOSSIE-HARNESS §2

Portar o modelo, reescrevendo a implementação (a deles é ~999 linhas próprias):

1. Hub = dir marcador `.nexusmemory/`; memórias = `.md` sem frontmatter, título = H1,
   filename = slug com sufixo de colisão; wikilinks `[[Título]]`/`[[Título|alias]]`.
2. **Sem índice**: list/read full-scan; search tokenizada com scoring (+5 título,
   +1 corpo teto 5, +3 verbatim, desempate por recência), modo `all` (AND) com dica
   automática para `any` em zero-hit; snippet com janelas mescladas ≤400 chars.
3. Escrita atômica tmp+rename; append com `O_APPEND|O_NOFOLLOW`; symlinks que resolvem
   fora do hub rejeitados; miss de read devolve 3 sugestões ranqueadas.
4. **Runtime gate**: token por sessão comparado constant-time contra arquivo;
   degradação graciosa (server sobe, tools respondem `isError` com hint acionável —
   nunca derruba o agente).
5. Descoberta: walk-up 64 níveis por cwd + fallback de "hub ativo" escolhido no painel.
6. Portar junto a **política editorial da SKILL** (só fatos duráveis, search-first,
   nunca criar hub silenciosamente) — é metade do valor.
7. Bônus do nosso lado: o grafo de wikilinks vira visualização nativa no renderer.

## T9 — Voz local (wake word + embedding)

**Evidência:** streams `_brotli/031/035/055/058` + strings `/models/{embedding_model,
hey-mycroft,melspectrogram}.onnx`, crates `cpal-0.15.3`/`coreaudio-rs`, strings
"BridgeVoice injection", DOSSIE.md §7

Pipeline deles: captura (cpal) → mel-spectrogram.onnx → wake word ("Hey Mycroft",
MLP Flatten+Gemm) → aciona agente de voz; embedding_model.onnx para busca semântica
local. No Nexus (Electron/Node):

1. Wake word: usar **openWakeWord ou similar MIT** com modelo próprio (ex. treinar
   "Hey Nexus") — **não shipar os .onnx da BridgeMind** (assets de produto fechado).
2. Áudio: `naudiodon`/native module ou sidecar Rust; pré-processamento mel em JS
   puro é viável (FFT + filterbank) para o formato openWakeWord.
3. Embedding local p/ busca semântica de memórias (T8) e histórico: MiniLM/ALL-MiniLM
   via onnxruntime-node + sqlite-vec — a lista de funções SQL com
   `ai_generate_embeddings` no CodeMirror deles sugere que eles pensaram o mesmo
   caminho.
4. Só valorizar se a voz for roadmap; o pipeline é pesado e isolado do resto.

## T10 — Padrões de runtime e superfície mínima

**Evidência:** `session.alive.v1.json`, `mobile-bridge-config.json`, strings ACL
Tauri (allow/deny de webview/window/shortcut/fetch/notification), `crash_sentinel_*`,
DOSSIE-HARNESS §5-P2-8

1. Heartbeat bucked (`rss_bucket`, contagens — nunca valores brutos) para crash
   reporting com privacidade.
2. Companion mobile **só loopback** + token próprio (modelo mobile-bridge).
3. A lista allow/deny de capabilities do Tauri é o modelo de "superfície mínima" —
   traduzir para o lockdown de IPC do Electron do Nexus (allowlist explícita de
   canais por contexto).
4. `crash_sentinel_*` + `expected_exit` no heartbeat: distingüir crash de shutdown
   limpo no próximo boot (o Nexus já sofre com isso — ver memória "pane fantasma").

---

## Nota de licença (vale para todas as tasks)

BridgeMind é produto comercial fechado. Extrair para estudo privado é uma coisa;
**shipar assets/código deles no Nexus é outra**. Portar = reinterpretação de
desenhos, protocolos e schemas (que descrevem comportamento, não expressão) +
reescrever implementação. Os itens marcados por task (fontes, logos, .onnx, código
.cjs verbatim) exigem reimplementação limpa. O harness em disco é do usuário (dados
dele) — schemas e formatos de arquivo são interoperabilidade legítima.
