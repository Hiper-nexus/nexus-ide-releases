# NexusIDE — Documento de Arquitetura (Fase 1)

> **Produto:** Terminal IDE multi-agente para macOS. Clone-e-supere do Overclock (baseline v0.7.5, engenharia reversa confirmada).
> **Status:** DESIGN ONLY — nenhum código de produto nesta fase.
> **Data:** 2026-07-03
> **Audiência:** executores das fases 2+ (`typescript-pro`, `electron-pro`, `frontend-developer`).
> **Fontes:** `recon-oss-multi-agent-terminal.md` (OSS/CLIs) + `voice-pipeline-report.md` (Jarvis) + **Adendo de engenharia reversa do Overclock v0.7.5** (fatos de primeira mão, incorporados em §E).

Este documento é **prescritivo e decisivo**. Onde há trade-off, a decisão está tomada e justificada.

---

## 0. Sumário Executivo das Decisões

| # | Decisão | Escolha | Justificativa curta |
|---|---|---|---|
| A | Runtime | **Electron + Electron Forge** | Overclock v0.7.5 é Electron/macOS 11+ (validação de primeira mão); node-pty/xterm/uiohook/onnx todos Node-native; Forge faz .dmg signing+notarization |
| B | Processos | **Main + Renderer + PTY Host (utilityProcess) + MCP embutido** | isola crash de PTY nativo; separa orquestração da UI |
| C | Panes | **Workspace → View(grid\|canvas) → Pane → Session**; grid = split-tree, canvas = `@xyflow/react`; ambos referenciam a MESMA Session | grid↔canvas sem re-spawn do PTY; supera o grid fixo do Overclock |
| D | Adapters | **JSON declarativo tipado: `cli-pty`, `api-provider`, `voice`**; hot-reload; substitui o hack 'shell' wrapper do Overclock | usuário adiciona CLI nova sem tocar código |
| E | Orquestração | **Domínio squads/missões/handoffs/catálogo + MCP embutido (24 tools, namespace `nexus_*`)**; skill-gate client+server | paridade exata Overclock + melhorias |
| F | Voz | **Jarvis v1: estende o audio-config real do ClockVoice + Silero VAD + Groq translate + TTS streaming + resposta falada** | supera o ditado-só do Overclock |
| G | Persistência/Segurança | **better-sqlite3 + Keychain (supera OC1 v10 que vazou JWT) + CSP + contextIsolation** | corrige fraqueza crítica do baseline |
| H | Build | **2a shell/grid → 2b adapters → 2c canvas → 2d orquestração → 2e voz → 3 QA/.dmg** | cada fase com entregável verificável |

---

## A. Decisão de Stack: Electron vs Tauri

### A.1 Tabela de trade-offs

| Critério | Electron | Tauri | Peso |
|---|---|---|---|
| PTY nativo | `@lydell/node-pty` / `node-pty` maduro (Overclock usa @lydell/node-pty v1.2.0-beta.12) | `portable-pty` (Rust) menos provado desktop | 🔴 Crítico |
| Terminal render | xterm.js em Chromium consistente + webgl garantido | xterm.js em WKWebView (quirks WebGL) | 🔴 Crítico |
| Hotkey global keyup | uiohook-napi (N-API) direto no main | crate Rust + bridge | 🟠 Alto |
| ONNX (Silero VAD) | onnxruntime-node no main | ort crate (duplica pipeline em Rust) | 🟠 Alto |
| .dmg signing+notarization | Electron Forge out-of-box | tauri build menos documentado macOS multi-binário | 🟠 Alto |
| RAM/bundle | ~150–250MB / ~120–200MB | ~40–80MB / ~10–40MB | 🟡 Médio (é dev tool) |
| 1 linguagem (TS) | Main+renderer+PTY+MCP todos TS | Rust + TS (2 toolchains) | 🟠 Alto |
| Paridade/reuso Overclock | **Overclock v0.7.5 É Electron** — mental model e porte direto | reescrita conceitual | 🔴 Crítico |

### A.2 Decisão: **Electron + Electron Forge**

O adendo de engenharia reversa **confirma de primeira mão** que o Overclock v0.7.5 roda em Electron (bundle `sh.overclock.app`, macOS 11+, URL scheme `overclock://`, auto-update via Squirrel, DB `better-sqlite3`). Isso valida a direção: herdamos mental model, padrões e potencial porte direto. Os quatro pilares (node-pty, xterm+webgl, uiohook-napi, onnxruntime-node) são todos Node-native maduros; em Tauri cada um exigiria ponte Rust↔JS. Footprint do Chromium é aceitável para dev tool desktop. **Electron decidido.** Ver §I para descartados.

### A.3 Stack canônico (pinado)

```
Runtime .............. Electron + Electron Forge (packaging/signing/notarization)
Linguagem ............ TypeScript (strict) em TODOS os processos
Frontend ............. React 18+ + TypeScript; Zustand (client state); zod (boundaries)
Terminal ............. @xterm/xterm + addons fit/webgl/search/serialize
PTY .................. @lydell/node-pty v1.2.0-beta.12 (fork usado pelo Overclock) — PRIMÁRIO;
                       node-pty-prebuilt-multiarch como alternativa se build nativo problemático
Canvas ............... @xyflow/react (MIT)  — NÃO tldraw (licença comercial)
Persistência ......... better-sqlite3 (síncrono, no main) — mesmo do Overclock
Voz — VAD ............ onnxruntime-node + Silero VAD (ONNX ~2MB)
Voz — hotkey ......... uiohook-napi (keydown/keyup global)
Secrets .............. Electron safeStorage / keytar → macOS Keychain (ou libsodium fallback)
MCP .................. @modelcontextprotocol/sdk (servidor embutido no main)
```

**Licenças (bundle, permissivas):** Electron, xterm.js, @lydell/node-pty, @xyflow/react, Silero VAD, uiohook-napi, Piper, whisper.cpp, better-sqlite3, onnxruntime-node — todas MIT/Apache/BSD. **Descartado por licença:** tldraw (comercial). **Só referência (não copiar código):** Claude Squad (AGPL-3.0).

---

## B. Arquitetura de Processos

### B.1 Topologia (4 processos)

```
MAIN (Node/TS): lifecycle, janelas, globalShortcut, orchestration domain,
                MCP server embutido, SQLite (better-sqlite3), voice engine
                (Silero VAD onnxruntime-node, STT/TTS), secrets (Keychain),
                adapter registry (carrega/valida/hot-reload plugins JSON)
   │ MessagePort (IPC tipado+zod)            │ spawn utilityProcess
   ▼                                          ▼
RENDERER (Chromium/React):                   PTY HOST (utilityProcess/Node):
  UI grid+canvas+panes, xterm.js,             @lydell/node-pty spawn/kill/resize,
  Zustand, mic (getUserMedia+AudioWorklet),   1 host p/ N sessões, isola crash
  Web Audio playback (TTS)                    nativo, stream bytes → renderer
                                              via MessagePort dedicado

contextIsolation:true, nodeIntegration:false, sandbox:true, contextBridge no preload.
Agentes CLI rodam DENTRO das sessões PTY; falam MCP com o servidor embutido.
```

### B.2 PTY Host separado (padrão VS Code)

@lydell/node-pty é addon nativo C++; segfault/FD-leak (cf. bug Gemini CLI #15945) **não pode derrubar main nem UI**. PTY Host é `utilityProcess` (mais leve que BrowserWindow, sem Chromium): mantém `sessionId → IPty`, streama bytes por MessagePort dedicado por sessão (baixa latência), recebe controle (spawn/write/resize/kill) do main, reinicia isolado com re-spawn de sessões recuperáveis.

### B.3 IPC tipado (não-negociável)

- `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`; renderer nunca toca Node/fs/child_process direto.
- **Todo** payload cross-boundary validado por **zod** no receptor (dados externos = untrusted).
- Canais por domínio: `pane:*`, `session:*`, `voice:*`, `orch:*`, `adapter:*`, `db:*`.
- Stream de bytes do PTY (`session:data`) usa **MessagePort transferido** à instância xterm (evita structured-clone por chunk); só controle usa canal JSON.
- Preload expõe `window.nexus` tipado (gerado do contrato) — sem `ipcRenderer` cru.

Contrato (design, `src/shared/ipc/contracts.ts`): canais `session:spawn/write/resize/kill/serialize`, `orch:mission.create`, `orch:handoff.list`, `voice:ptt.transcribe`, `adapter:list/reload` (invoke); `session:data/exit`, `orch:handoff.received`, `voice:tts.chunk`, `adapter:changed` (events). Cada Input é `z.object(...)`.

### B.4 Sessões PTY

- `Session` nasce de `SpawnSessionInput` (adapterId+model+cwd+env); main resolve adapter, monta spawnArgs+env, injeta `$HOME` efêmero se skill-gated, pede spawn ao PTY Host.
- **Session ≠ Pane**: referenciada por `sessionId`; panes de grid e canvas apontam para o mesmo id. Fechar pane não mata session salvo último referenciador (`killOnLastPane` default true, exceto missões).
- Idle/busy via `stateParsing` do adapter → alimenta `pane_wait_idle`.
- Buffer serializado (@xterm/addon-serialize) → SQLite ao fechar; re-hidratado ao reabrir.

---

## C. Sistema de Panes (Grid + Canvas Infinito)

### C.1 Modelo de dados

```
Workspace(1) ──< View(N: 1 grid + 0..N canvas)
  │                ├ GridLayout (split-tree)   ──< PaneRef ─┐
  │                └ CanvasLayout (xyflow nodes) ──< PaneRef ─┤ referencia por sessionId
  └──< Session(N) ◄──────────────────────────────────────────┘  (pty vivo + buffer xterm + adapter)
```

**Regra de ouro:** estado de terminal vive em `Session`, não no Pane. Grid e Canvas são projeções de layout sobre as mesmas Sessions — é o que torna o canvas 'grátis'.

Interfaces (design): `Workspace{id,name,views,activeViewId}`; `View = {kind:'grid',layout:SplitNode} | {kind:'canvas',nodes:CanvasNode[],viewport}`; `Session{id,adapterId,providerId?,model?,cwd,ptyId,status,serializedBuffer?}`; `SplitNode = {kind:'leaf',paneRef} | {kind:'split',dir:'row'|'col',ratio,a,b}`; `CanvasNode{id,paneRef,position,size,z}`; `PaneRef{paneId,sessionId,title}`.

### C.2 Grid (split-tree)

Árvore binária (row/col + ratio, mental model tmux/VS Code). Ops: splitPane/resizeSplit/closePane(colapsa irmão)/focusPane. Render CSS flex recursivo; divisores arrastáveis animando só flex-basis/transform (nunca width/height em loop). Cada leaf hospeda `<TerminalPane sessionId>` com addon-fit + ResizeObserver → `session:resize` (cols/rows ao PTY).

### C.3 Canvas infinito (@xyflow/react) — DIFERENCIAL sobre Overclock

Overclock tem **grid fixo, sem canvas arrastável**. NexusIDE adiciona modo canvas: pane = custom node xyflow arrastável livremente, redimensionável, z-order; `<MiniMap/>`, `<Controls/>`, `<Background/>` (dots), pan/zoom trackpad. Edges representam relações de orquestração (orquestrador→worker, missão→panes), animadas em handoff. Performance: em zoom-out, nós abaixo de threshold renderizam **snapshot congelado** (canvas image do serialize) em vez de xterm ativo; `onlyRenderVisibleElements`.

### C.4 Grid ↔ Canvas compartilhando sessão

1. **Reparent (preferido):** instância xterm+div mantida viva num `SessionSurfacePool` fora da árvore React; grid/canvas apenas reposicionam (portal) o mesmo DOM — O(1), zero re-spawn.
2. **Serialize/attach (fallback/persistência/mover-janela):** addon-serialize captura buffer; nova instância faz write(serialized) + reattach ao mesmo PTY stream.

---

## D. Adapter System (Plugins Declarativos JSON)

Três tipos, todos declarativos, em `~/.nexus/plugins/`, zod-validados, hot-reload. **Substituem explicitamente o hack 'shell' do Overclock** (que roda QUALQUER CLI via wrapper `~/ai-launcher/ai gr|fugu` SEM handoff nativo). Nossos adapters tipados dão handoff/estado/modelos de primeira classe a qualquer CLI.

### D.1 Adapter `cli-pty`

Campos: `kind:'cli-pty'`, `id`, `label`, `version`, `icon`, `bin`, `detect`, `install{method,command}`, `auth{method:oauth|api_key|device_code|subscription|none, envVarFallback, credentialStore, loginHint}`, `spawn{interactive[], headless[], headlessJson[], ptyRequired, resumeArgs[], extraArgs[]}` (placeholder `{{PROMPT}}`/`{{SESSION_ID}}`), `env{static{}, passthrough[], ephemeralHome:bool}`, `models{flag, list[], default}`, `promptInjection{method:stdin|arg|flag, flag, trailingNewline, bracketedPaste}`, `stateParsing{idle{type:regex,pattern}, busy{...}, shellIntegration:bool, exitCodes{}}`, `quirks{altScreen, requiresNoAutoUpdate, approvalFlag, mcpAutoload}`.

**Adapters iniciais (do recon):** claude, codex, agy (Antigravity — substitui gemini descontinuada), kimi, grok, aider (único ptyRequired:false em headless), opencode → `cli-pty`. fugu, glm → `api-provider`.

**Quirks pinados:** grok `requiresNoAutoUpdate:true`+`approvalFlag:'--always-approve'`; aider `ptyRequired:false`,`altScreen:false`; claude/agy/kimi `altScreen:true`; agy sem `--max-turns` (usar `--print-timeout`). Nota: os cli-types nativos do Overclock são claude|codex|kimi|antigravity|shell — cobrimos todos e generalizamos via JSON.

### D.2 Adapter `api-provider`

Campos: `kind:'api-provider'`, `id`, `label`, `endpoint`, `protocol:openai-chat|openai-responses|anthropic-messages`, `auth{method:api_key, header, scheme, envVar, keychainKey}`, `models{list[],default}`, `streaming`, `quirks`. Não spawna PTY — cliente HTTP interno + pane de chat, ou exposto como modelo p/ cli-pty com base-URL custom (aider/opencode via LiteLLM). Descoberta espelha `pane_list_providers`. Ex: glm (BigModel), fugu (Sakana).

### D.3 Adapter `voice`

Schema já no voice-pipeline-report (Entregável 3), adotado e ESTENDIDO do audio-config real do ClockVoice (ver §F). STT: groq(default), openai, deepgram, assemblyai, local-whisper, mlx-whisper. TTS: openai(default), elevenlabs, piper, kokoro, macos-say. VAD: silero(default), webrtc.

### D.4 Diretório, hot-reload, validação

```
~/.nexus/
├── plugins/{adapters,voice,themes,keybindings}/*.json (+assets)
├── models/  (whisper, piper)
├── bin/     (piper, whisper-cpp)
└── nexus.db (SQLite)
```
(Espelha a organização do Overclock em `~/.overclock-app/`: squads.json, audio-config.json, plugins/cache/.)

Registry (main) varre no boot, valida cada JSON com zod do seu `kind`; inválido → rejeitado fail-fast. Hot-reload via chokidar → `adapter:changed`. Sessions vivas mantêm snapshot do adapter (imutabilidade). Plugin do usuário sobrescreve built-in por `id`. Versionamento via `$schema`+`version`.

---

## E. Camada de Orquestração + MCP Embutido (Paridade Overclock v0.7.5)

### E.1 Domínio squads (replicando o schema REAL do Overclock)

Formato de squad JSON confirmado por engenharia reversa — replicado para compatibilidade conceitual:

```jsonc
{ "squads": [ {
  "id": "...", "name": "...", "createdAt": "...", "builtin": false,
  "orchestratorInstructions": "# markdown...",
  "agents": [ {
    "id": "...", "agentName": "...",
    "category": "orchestrator|scout|executor|reviewer|architect",
    "cli": "claude", "providerId": "...", "model": "...",
    "effort": "low|medium|high|xhigh",
    "allowedSkills": [], "allowedTools": []
  } ]
} ] }
```

Notas de paridade: `category` inclui **orchestrator** (não só os 4 worker roles); `orchestratorInstructions` é markdown; `effort` pinado por agente; allowlists por agente alimentam o skill-gate (§E.4). **Melhoria nossa:** export/import de squads (JSON), que o Overclock NÃO tem.

### E.2 Servidor MCP embutido — 24 tools (paridade EXATA, namespace `nexus_*`)

Main hospeda MCP server (@modelcontextprotocol/sdk); cada CLI-agente conecta via stdio/socket local injetado no spawn. As 24 tools do Overclock, renomeadas mantendo semântica:

| Grupo | Tools (semântica idêntica) |
|---|---|
| Panes (10) | `nexus_pane_spawn`, `nexus_pane_list`, `nexus_pane_list_providers`, `nexus_pane_read`, `nexus_pane_read_many`, `nexus_pane_write`, `nexus_pane_write_many`, `nexus_pane_close`, `nexus_pane_wait_idle`, `nexus_pane_wait_many` |
| Handoffs (2) | `nexus_handoff_submit`, `nexus_handoff_list` |
| Agentes (3) | `nexus_agent_invoke`, `nexus_agent_list`, `nexus_agent_get` |
| Missões (5) | `nexus_mission_create`, `nexus_mission_get`, `nexus_mission_list`, `nexus_mission_set_status`, `nexus_mission_spawn_pane` |
| Squad/Catálogo/Task (3) | `nexus_squad_save`, `nexus_catalog_install`, `nexus_task` |
| Todos (1) | `nexus_todo_manager` |

Aliases `overclock_*`/`pane_*`/`handoff_*` mantidos no registry (namespace duplo) para compat de agentes/prompts existentes. **Sempre permitidos independente de allowlist:** `ToolSearch`, `nexus_handoff_submit`, `nexus_handoff_list`.

### E.3 Handoffs — mecanismo real + MELHORIA

**Mecanismo do Overclock (confirmado):** 3 hooks `.mjs` gerados por sessão+pane — PostToolUse (escreve **marker file**), Stop (bloqueia saída se marker ausente, máx 3 tentativas), PreToolUse (whitelist skill-gate, exit 2 se fora da allowlist; `ALLOWED_TOOLS`/`ALLOWED_SKILLS` null = irrestrito). Worker chama `handoff_submit({status,summary,artifacts})`; orquestrador coleta via `handoff_list`.

**MELHORIA NexusIDE:** substituir **marker files temporários** por **SQLite + IPC tipado**. Handoff gravado numa tabela `handoffs`; evento `orch:handoff.received` ao orquestrador; Stop-gate consulta o DB (não o filesystem). Elimina corrida/lixo de arquivos e dá durabilidade + auditabilidade. Entrega automática quando o orquestrador fica ocioso (paridade). Formato legado `### OVERCLOCK_HANDOFF v1` no terminal suportado como fallback de parsing. `outputSchema` valida artifacts no submit.

### E.4 Skill-gate (enforcement duplo)

Ao spawnar worker, injeta hook PreToolUse + `$HOME` efêmero (isola config/skills). Hook consulta `allowedSkills`/`allowedTools` do agente e bloqueia fora da allowlist (exit 2). **Defesa em profundidade:** o MCP server TAMBÉM recusa server-side chamadas fora da allowlist do worker chamador — não confiar só no hook client-side. (Este próprio worker está sob esse gate: Write/Bash bloqueados.)

### E.5 Paridade Overclock — Matriz (adendo v0.7.5 INCORPORADO)

| Feature Overclock v0.7.5 | Coberta por | Detalhe de impl. observado |
|---|---|---|
| Grid de panes (CLI/shell por pane) | §C.2, §B.4 | Grid fixo; layout em LevelDB (`~/Library/Application Support/Overclock/`). Nós usamos SQLite/Zustand + adicionamos canvas |
| Spawn agent/providerId/model/cwd | §B.4 | cli-types: claude\|codex\|kimi\|antigravity\|shell |
| Provider 'shell' (wrapper `~/ai-launcher/ai gr\|fugu`) | §D.1 | Hack sem handoff nativo → SUBSTITUÍDO por adapters cli-pty/api-provider tipados |
| Providers + `pane_list_providers` | §D.2, §E.2 | — |
| Squads (schema real: id/name/createdAt/builtin/orchestratorInstructions/agents[]) | §E.1 | category inclui orchestrator; effort low\|high\|xhigh; allowedSkills/allowedTools por agente |
| Skill-gate (`$HOME` efêmero + hooks .mjs) | §E.4 | PreToolUse exit 2; null=irrestrito; sempre: ToolSearch/handoff_submit/handoff_list |
| Missões (create/get/list/set_status/spawn_pane) | §E.1, §E.2 | Estado em `~/.overclock-app/messages.db` (better-sqlite3) |
| `todo_manager` + milestones visíveis | §E.2 | — |
| Handoffs (submit/list; 3 hooks .mjs; marker+Stop máx 3; artifacts/outputSchema) | §E.3 | MELHORADO: marker files → SQLite+IPC |
| Entrega auto quando ocioso + legado `### OVERCLOCK_HANDOFF v1` | §E.3 | — |
| Catálogo (aitmpl 70+ agentes, davila7/claude-code-templates) | §E.6 | API `GET /api/catalog/search?q=&kind=agent\|skill\|command&limit=`; plugin `.claude-plugin/plugin.json` |
| Voice/ditado ClockVoice (audio-config real) | §F | groq/whisper-large-v3/pt→english/hold/Space/coding/190wpm/4700ms — ESTENDIDO p/ Jarvis (TTS) |
| 24 MCP tools | §E.2 | Renomeadas `nexus_*`, semântica idêntica |
| Auth backend (Supabase + Google OAuth) | opcional | NexusIDE v1 é local-first — auth de nuvem é OPCIONAL, não requisito |
| Config dirs (`~/.overclock-app/`: squads.json, audio-config.json, dropped/, plugins/cache/) | §D.4 | Espelhado em `~/.nexus/` |
| Auto-update (Squirrel) | §G.4 | Forge maker ZIP + Squirrel.Mac |
| **Novo:** canvas infinito arrastável | §C.3 | 🚀 supera grid fixo |
| **Novo:** multi-CLI universal declarativo | §D | 🚀 supera hack 'shell' |
| **Novo:** resposta falada TTS (Jarvis) | §F | 🚀 supera ditado-só |
| **Novo:** UI de debug de missões/handoffs | §E.6 | 🚀 Overclock não tem |

### E.6 Melhorias sobre o Overclock (fraquezas superadas)

1. **Criptografia OC1 v10 (quebrou 2x, vazou JWT em plaintext)** → NÃO reimplementar cripto caseira. Usar **macOS Keychain** via `safeStorage`/`keytar`; se indisponível, **libsodium** (secretbox) com **fallback gracioso** e nunca degradar para plaintext. Secrets jamais em SQLite/logs.
2. **Handoffs por marker files temporários** → **SQLite + IPC tipado** (§E.3): durável, auditável, sem corrida.
3. **Sem export/import de squads** → export/import JSON nativo do squad schema (§E.1).
4. **Grid fixo sem canvas** → modo canvas @xyflow/react arrastável (§C.3).
5. **Sem UI de debug de missões** → view dedicada: timeline de missões, estado de workers, handoffs em voo como edges animadas no canvas, inspeção de artifacts.

**Catálogo (paridade + detalhe real):** integração aitmpl (davila7/claude-code-templates, 70+ agentes). `nexus_catalog_install` chama `GET https://.../api/catalog/search?q=<termo>&kind=agent|skill|command&limit=<n>` e instala plugins no formato `.claude-plugin/plugin.json` em `~/.nexus/plugins/`.

---

## F. Pipeline de Voz Jarvis (estende o ClockVoice real)

### F.0 Ponto de partida: audio-config REAL do Overclock (ClockVoice)

```jsonc
{ "provider":"groq", "baseUrl":"https://api.groq.com/openai/v1", "model":"whisper-large-v3",
  "language":"pt", "outputMode":"english", "captureMode":"hold",
  "pushToTalkKey":{"code":"Space"}, "interactionMode":"coding", "targetWpm":190, "chunkMs":4700 }
```

NexusIDE **usa o MESMO formato base** e o ESTENDE com: bloco `stt.vad` (Silero), `stt.fallback` (whisper.cpp local), bloco `tts` completo (OpenAI tts-1 streaming → Piper → macOS say) e **resposta falada** (o diferencial Jarvis). Migração de config do Overclock é trivial (superset).

### F.1 Fluxo integrado à topologia de processos

```
Hotkey global: globalShortcut(keydown) + uiohook-napi(keyup, pois globalShortcut não emite key-up)
  → renderer 'voice:ptt.start'
[Renderer] getUserMedia 16kHz mono + AudioWorklet → PCM chunks → ipc 'voice:chunk'
[Main] Silero VAD (onnxruntime-node) — silêncio descarta (minSpeechMs 300, maxSilenceMs 800)
[Main] STT Groq whisper-large-v3 task=translate PT→EN (fallback whisper.cpp base/Metal)
[Main] ROTEAMENTO (§F.2): session:write no pane-alvo OU orquestrador
[Agente processa] → resposta texto (pane_read / handoff summary)
[Main] Sumário falável (§F.3) → TTS OpenAI tts-1 streaming voz onyx
       (fallback Piper pt_BR-faber-medium → macOS say Luciana) → 'voice:tts.chunk'
[Renderer] Web Audio playback → usuário OUVE (Jarvis)
```
Latência v1 cloud: ~2.5–5s ponta-a-ponta (aceitável p/ IDE).

### F.2 Roteamento
`voice.routing: 'focused-pane'(default) | 'orchestrator' | 'ask'`. Voz vira texto injetado via `session:write` (idêntico a digitar). Com Squad ativo, pode ir ao orquestrador que delega via MCP.

### F.3 Resposta falada (Jarvis — supera Overclock)
Overclock só dita→injeta. NexusIDE fala de volta: fonte = summary de `handoff_submit` ou última resposta idle (via pane_read); passo de condensação leve → 1–3 frases faláveis; código/texto longo NÃO é falado na íntegra. `voice.speakMode: 'summary'(default)|'full'|'off'`. TTS streaming: 1ª palavra ~500ms.

### F.4 Decisões v1 pinadas
✅ Push-to-talk (não wake word) ✅ STT batch (Groq rápido) ✅ tradução no ASR (task=translate) ✅ TTS streaming. ❌ Realtime full-duplex → v2. Wake word (openWakeWord Apache-2.0 / Porcupine comercial) → v2.

---

## G. Persistência, Modularidade, Segurança, Empacotamento

### G.1 Persistência (better-sqlite3, `~/.nexus/nexus.db`)
Síncrono no main; migrations versionadas. Tabelas (design): workspaces, views(kind, layout_json, viewport_json), sessions(adapter_id, provider_id, model, cwd, status, serialized_buffer), missions(status, milestones_json), handoffs(from_worker, summary, status, artifacts_json, output_schema_json), squads(orchestrator_instructions, roster_json), configs(key, value_json), adapters_meta(kind, version, source, enabled). **Secrets NÃO ficam aqui** — Keychain (§G.3). (Overclock separa messages.db + LevelDB para layout; nós unificamos em SQLite.)

### G.2 Modularidade
Temas (JSON, CSS custom properties `--color/*text/*space/*duration` — sem palette hardcoded; terminal 16-ANSI + UI; light E dark ambos intencionais). Keybindings (JSON command→key, chords, command registry central). Layouts (workspaces salvos reabríveis, templates instaláveis). Plugins (adapters/voice/themes/keybindings, hot-reload). Sistema de plugins inspirado em Tabby (DI→React context) e Hyper (composição) — referência, não porte (Hyper abandonado).

### G.3 Segurança
| Superfície | Controle |
|---|---|
| Renderer | contextIsolation/sandbox true, nodeIntegration false, sem remote |
| IPC | zod no receptor; contextBridge mínimo; sem ipcRenderer cru |
| CSP | estrita (default-src 'self', sem unsafe-eval, sem remote scripts) |
| Spawn | node-pty só no PTY Host; argv array (sem shell-string concat); $HOME efêmero p/ skill-gated |
| **Secrets** | **macOS Keychain (safeStorage/keytar) ou libsodium fallback gracioso — SUPERA o OC1 v10 que quebrou 2x e vazou JWT plaintext**. Nunca em SQLite/logs; resolução on-demand no spawn |
| Skill-gate | client (hook) + server (MCP) — defesa em profundidade |
| Plugins untrusted | JSON fail-fast; adapters não executam código arbitrário (só declaram argv/env) |
| Mic | entitlement microphone + NSMicrophoneUsageDescription; captura só sob PTT |
| Auth nuvem (opcional) | Supabase/Google OAuth do Overclock NÃO é requisito v1 (local-first); se adicionado, tokens no Keychain |

### G.4 Empacotamento (.dmg)
Electron Forge: maker-dmg (final) + ZIP (auto-update Squirrel.Mac, como Overclock). Signing `@electron/osx-sign` (Developer ID). Notarization `@electron/notarize`. Entitlements: microfone + hardened runtime + allow-jit (V8). Native rebuilds: @lydell/node-pty, better-sqlite3, onnxruntime-node, uiohook-napi, keytar (prebuilt multiarch; universal arm64+x64). macOS-only. URL scheme `nexus://`.

---

## H. Plano de Build Faseado

**2a — Shell+Grid+Terminal:** Forge scaffold; Main+Renderer+PTY Host; IPC+zod; xterm+addons; grid split-tree; spawn shell. *Verificável:* grid splita, cada pane roda zsh real; matar PTY Host não derruba app.

**2b — Adapters:** registry + zod (cli-pty/api-provider); hot-reload; seletor por pane; adapters JSON (claude/codex/agy/kimi/grok/aider/opencode + glm/fugu); stateParsing. *Verificável:* spawn claude+codex; adicionar CLI nova só dropando JSON (sem rebuild); pane_wait_idle correto.

**2c — Canvas:** @xyflow/react; pane=custom node; pan/zoom/minimap; SessionSurfacePool (reparent grid↔canvas sem re-spawn); frozen em zoom-out; edges de orquestração. *Verificável:* alternar grid↔canvas mantém MESMO PTY vivo; fluido com ≥6 terminais.

**2d — Orquestração+MCP:** MCP server 24 tools (nexus_*); domínio squads(schema real)/missões/handoffs (SQLite+IPC, não marker files); todo_manager; skill-gate duplo; entrega auto ocioso; parser legado; catálogo aitmpl. *Verificável:* Squad orquestrador+2 workers delega via pane_spawn/write; worker handoff_submit; entregue ao ficar ocioso; skill fora da allowlist BLOQUEADA; export/import de squad funciona.

**2e — Voz Jarvis:** PTT (globalShortcut+uiohook keyup); getUserMedia+AudioWorklet; Silero VAD; STT multi (Groq+whisper.cpp); roteamento; TTS streaming (OpenAI→Piper→say); sumário falável; voice plugin estendendo audio-config. *Verificável:* segurar PTT, falar PT, ver EN injetado, agente responde, **NexusIDE fala resumo**; sem key → whisper.cpp+Piper/say.

**3 — QA+.dmg:** testes (unit domínio/adapters/parsers; integração IPC/MCP; E2E Playwright: grid/canvas/spawn/handoff/voz); a11y + reduced-motion; signing+notarization; universal .dmg. *Verificável:* .dmg assinado+notarizado instala em máquina limpa; E2E verde; 3 fluxos-farol (multi-CLI, canvas, Jarvis) passam.

---

## I. Riscos e Alternativas Descartadas

### I.1 Descartados
| Descartado | Em favor de | Razão |
|---|---|---|
| Tauri (Rust) | Electron | node-pty/xterm-webgl/uiohook/onnx Node-native; WKWebView quirks; 2 linguagens; **Overclock v0.7.5 é Electron (confirmado)** |
| tldraw | @xyflow/react | Licença SDK comercial paga |
| Gemini CLI | Antigravity (agy) | Descontinuada 18/jun/2026 |
| electron-builder | Electron Forge | Oficial; signing/notarization out-of-box |
| Realtime duplex voz | Batch v1 | Complexidade WebSocket+sync = risco alto; v2 |
| Wake word em v1 | Push-to-talk | Porcupine comercial; PTT zero falso-positivo; v2 |
| Backend Go (Wave) | Node/TS no main | 1 linguagem (Overclock também é Node/Electron) |
| Hack 'shell' wrapper | Adapters JSON tipados | 'shell' do Overclock não tem handoff nativo |
| Cripto caseira (OC1 v10) | Keychain/libsodium | OC1 quebrou 2x e vazou JWT plaintext |
| Marker files p/ handoff | SQLite+IPC | Corrida/lixo/frágil |
| Copiar Claude Squad | Só ref UX | AGPL-3.0 copyleft |

### I.2 Riscos e mitigações
| Risco | Sev | Mitigação |
|---|---|---|
| Crash node-pty derruba app | Alta | PTY Host utilityProcess isolado + re-spawn |
| xterm-webgl pesado no canvas | Alta | frozen snapshot em zoom-out; onlyRenderVisibleElements; SurfacePool |
| CLIs mudam flags (grok beta, kimi novo) | Média | Quirks no adapter JSON — patch sem rebuild |
| Alt-screen TUI idle/busy difícil | Média | stateParsing + OSC 133 + timeout (agy --print-timeout) |
| Latência voz alta | Média | Batch Groq + TTS streaming + fallback local |
| Pricing STT/TTS incerto | Baixa | Providers plugáveis; default Groq barato; fallback local |
| Notarization falha em native modules | Média | Prebuilt multiarch; hardened runtime; testar signing cedo |
| Skill-gate contornável | Alta | Enforcement duplo (hook + MCP server-side) |
| Secrets vazando (como OC1) | Alta | Só Keychain/libsodium; nunca SQLite/logs |
| @lydell/node-pty é beta (v1.2.0-beta.12) | Média | Overclock roda em produção com ele; fallback node-pty-prebuilt-multiarch |

---

## Apêndice — Reuso OSS (licenças)
| Fonte | Licença | Uso |
|---|---|---|
| Electron, xterm.js, @lydell/node-pty, @xyflow/react, Silero VAD, uiohook-napi, Piper, whisper.cpp, better-sqlite3, onnxruntime-node | MIT/Apache/BSD | Bundle direto (atribuição) |
| Wave Terminal | Apache-2.0 | Ref arquitetural (bloco/sync/SQLite) |
| VS Code terminal | MIT | Ref (Pty Host, ShellIntegrationAddon) |
| Tabby | MIT | Ref plugin system |
| Hyper | MIT | Ref composição (abandonado — não base) |
| Conductor (MS) | MIT | Ref delegação |
| Claude Squad | AGPL-3.0 | Só UX (não copiar código) |
| tldraw | Comercial | ❌ não usar |

*Fim. Adendo Overclock v0.7.5 incorporado (§E, §F.0, §G.3, §I). Nenhuma decisão estrutural mudou — o adendo validou a direção Electron e refinou detalhes de paridade, handoff, voz e segurança.*
