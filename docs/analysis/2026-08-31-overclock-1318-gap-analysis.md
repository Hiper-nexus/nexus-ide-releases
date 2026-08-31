# Overclock 1.3.18 × Nexus IDE 0.70.21 — gap analysis

**Data:** 2026-08-31
**Checkout Nexus:** `/Users/cleofasrocha/dev/nexus-ide` · branch `main` · `package.json` `0.70.21` · HEAD `1b2ea7fa` (“release: 0.70.21 — Corrente viva”)
**Overclock inspecionado:** `/Applications/Overclock.app` · `CFBundleShortVersionString` **1.3.18** · identifier `sh.overclock.app` · assinado 28 Aug 2026 17:33 (Developer ID Guilherme Laschuk T4BPBR7L76, ticket de notarização grampeado)
**Método:** leitura apenas. Nada foi escrito em `/Applications/Overclock.app` nem em `/Users/cleofasrocha/.overclock-app`. Extração de strings (`strings`, `otool -L`, `plutil`, `codesign -dv`, `python3` só para *keys* de JSON). Sidecar `index.jsc` é bytecode bytenode — nomes e mensagens são evidência de superfície, não de implementação linha a linha.

**Lenda**

| Marca | Significado |
|---|---|
| **FEITO** | Achado verificado: arquivo:linha no Nexus cobre o item das notas |
| **PARCIAL** | Existe mecanismo no Nexus, mas falta o recorte que a nota descreve |
| **FALTA** | Busca no repo (e no binário, quando aplicável) não achou equivalente |
| **N/A-plataforma** | Item é Windows/Linux/instalador; o app instalado aqui é macOS arm64 |
| **H** | Hipótese: inferência a partir de strings/marketing, sem prova de comportamento |

Separação deliberada: o que o binário/disco **mostra** vs. o que as release notes **prometem**. Quando as notas falam “cache de vértices e VBO por pane” e o binário **não** contém `wgpu`/`VBO`/`vertex cache`, isso entra como **H**, não como achado.

Análises anteriores neste repo (`docs/analysis/2026-08-05-overclock-parity-gap.md`, `2026-08-21-cruzamento-overclock-nexus.md`, `2026-08-02-overclock-124-distill.md`) cobriam **1.2.4 / 1.3.5**. Esta varredura é da **1.3.18 instalada hoje**.

---

## 1. Inventário do que foi realmente inspecionado

### 1.1 Bundle `/Applications/Overclock.app`

Confirmado em 2026-08-31:

| Caminho | O que é | Como confirmei |
|---|---|---|
| `Contents/Info.plist` | versão **1.3.18**, display name Overclock, URL scheme `overclock://`, `LSMinimumSystemVersion` 10.13 | `defaults read` + `plutil -p` |
| `Contents/MacOS/overclock` | Mach-O arm64, 24 MB. Shell **Tauri 2.11.2** + crate `overdrive_term` | `file`, `otool -L`, `strings` (`tauri-2.11.2`, `src/overdrive_term/{commands,session,registry,porteiro,native_rpc,mod}.rs`) |
| `Contents/MacOS/node` | Node runtime 105 MB (Mach-O arm64) | `file`, `ls -lh`; sidecar `bin/node -v` → **v22.16.0** |
| `Contents/Resources/sidecar/dist/index.js` | loader bytenode de 132 B | `cat` |
| `Contents/Resources/sidecar/dist/index.jsc` | bytecode 3.9 MB, sha256 `f20c34d1…b2ac4c` | `file` = `data`; `strings` extraem tools MCP e mensagens 1.3.x |
| `Contents/Resources/sidecar/package.json` | `@overclock-app/sidecar` 0.1.0, deps workspace `@overclock-app/{bus,catalog,core,ipc-types,mcp,pty}`, `@sentry/node`, `bytenode`, `ws` | `cat` |
| `Contents/Resources/sidecar/arms-mcp/*.js` | conector **Overclock Arms** (JS **legível**) | `cat` de `bin.js`, `index.js`, `proxy.js` |
| `Contents/Resources/resources/` | arsenal + crews de fábrica | `find` → **72 arquivos** de conteúdo (notas 1.3.13: “49 arquivos de arsenal restaurados”; o bundle 1.3.18 tem mais que 49 porque inclui agents/PLAYBOOK além dos skills) |
| `Contents/Resources/resources/THIRD-PARTY-LICENSES.html` | 1.0 MB | `ls -lh` |
| `*.asar` | **não existe** | `find /Applications/Overclock.app -name '*.asar'` vazio. 1.3.18 **não é Electron**; não há `app.asar` |

`otool -L` do binário `overclock`: AppKit, WebKit, CoreGraphics, CoreVideo, AudioToolbox, CoreAudio, Security, Carbon, ColorSync — **sem** `Metal.framework`, **sem** Electron Helper. `strings` acham `setWantsBestResolutionOpenGLSurface` e crates `alacritty_terminal-0.25.1` + `vte-0.15.0`. Não acham `wgpu`, `VBO`, `vertex cache`.

IPC nativo extraído do binário (comandos Tauri): `overdrive_spawn`, `overdrive_write`, `overdrive_feed`, `overdrive_resize`, `overdrive_kill`, `overdrive_attach`, `overdrive_snapshot`, `overdrive_snapshot_compact`, `overdrive_read_plain`, `overdrive_read_history`, `overdrive_read_grid`, `overdrive_set_visibility`, `overdrive_scroll`, `overdrive_paste`, `overdrive_mouse_button`, `overdrive_ack`, `engine_probe`, `sidecar_retry`. String de boot Windows/sidecar: `o reportou porta` + `overdrive-native-rpc`.

Plugins Tauri no binário: `tauri-plugin-updater/2.10.1`, websocket, dialog, clipboard-manager, notification, deep-link, single-instance. String `managedBy` + `overclock-bot` (nota 1.3.15).

Codesign: runtime hardened, notarizado, timestamp 28 Aug 2026 17:33.

### 1.2 Sidecar vivo (`~/.overclock-app/sidecar.json`) — keys apenas

Lido em `/Users/cleofasrocha/.overclock-app/sidecar.json` **sem** o campo `token`:

- `version`: `"1.3.18"`
- `port`: 51737
- `mcp`: `http://127.0.0.1:51737/mcp`
- `orchestrator`: `http://127.0.0.1:51737/mcp/orchestrator`
- `armsCommand`: Node do sidecar + `arms-mcp/bin.js`
- `dev`: false
- `installRoot`: `…/Contents/Resources/sidecar`

O sidecar **está rodando nesta máquina** (pid presente no descritor). Não matei o processo.

### 1.3 Home `/Users/cleofasrocha/.overclock-app` (listagem, sem segredos)

Presente. O `HOME` do pane Grok é sandboxed (`.nexus-home`); a leitura usou caminho absoluto.

Arquivos relevantes (nomes + tipos; **valores de token/key não foram copiados**):

| Arquivo | Papel |
|---|---|
| `session.json` | sessão (mode 600) |
| `license-claim.json` | keys `body`, `cachedAt`, `email`, `version` |
| `config.json` | keys `discordRichPresence`, `firstRun`, `lastWorkspacePath`, `leaderboard`, `onboarding`, `performance`, `privacy`, `terminal` |
| `performance` | `hardwareAcceleration: true`, `lowGpuMode: false` |
| `privacy` | `crashReportingEnabled`, `crashReportingAsked` (bools) |
| `audio-config.json` | provider `groq`, model `whisper-large-v3`, `localBinaryPath`/`localModelPath` vazios, `language: pt` |
| `providers.json` | 3750 B, mode 600; marcador `.providers-encryption-broken` desde 2026-07-01 |
| `vault` implícito | `keystore.key`, `service-keys.json`, strings no jsc `vault.json` / `vault:get` |
| `arms.json` + `arms.token` | conector Arms (keys `token`, `rotatedAt`, `revokedAt`) |
| `mcp-config.json` / `mcp-config.sidecar.json` | MCP local |
| `squads.json` | factory ids vivos: `oc-cinema-site` (6), `oc-app-factory` (5), `oc-saas-10k` (4), `oc-autopilot` (4), `oc-arcade` (4) |
| `missions.json`, `messages.db` | runtime |
| `redline-last-good.json`, `redline-history.jsonl` | integração Redline (arquivos existem) |
| `handoff-deliver.mjs`, `handoff-stop.mjs`, `overclock-doctor.mjs`, `soft-status.mjs` | hooks/doctor first-party |
| `remote-bridge/` | VPS/remoto |

**Redline.app não está instalado:** `ls '/Applications/Overclock Redline.app/…/Redline'` → No such file. O jsc ainda referencia `/Applications/Overclock Redline.app/Contents/MacOS/Redline` e `redline_pick_account`.

### 1.4 Arsenal embutido (1.3.13 restaurou; 1.3.18 ainda embarca)

Crews em `Contents/Resources/resources/`:

- `arsenal/skills/` — 15 skills `oc-*` + `qa-finding-protocol` / `qa-fix-protocol`
- `cinema/` + `cinema-site/` — PLAYBOOK + agents + skills
- `qa-swarm/` — 5 agents (scout/builder/worker/reviewer/observer)
- `qa-vision/` — 3 agents
- `squad-former/` — 2 agents + 6 skills
- `absurd-landing/` — 8 agents + PLAYBOOK

Strings no jsc: `arsenal factory squad(s) (C-141)`, ids `oc-cinema-site`, `oc-app-factory`.

### 1.5 Superfície MCP extraída do `index.jsc` (1.3.18)

Tools com prefixo `overclock_` (unicidade via `strings | sort -u`):

`overclock_agent_{get,list}`, `overclock_audio_generate`, `overclock_catalog_{install,inventory,overlay_write,stacks_write,status,uncategorized}`, `overclock_clarify`, `overclock_cron_{create,delete,list}`, `overclock_image_generate`, `overclock_logo`, `overclock_marketplace_search`, `overclock_media_providers`, `overclock_memory_{read,write}`, `overclock_mission_{create,get,list,set_status,spawn_pane}`, `overclock_model_list`, `overclock_navigate`, `overclock_open_browser`, `overclock_perf_events`, `overclock_recipe_{get,list,save}`, `overclock_skill_list`, `overclock_skin_{apply,get,list}`, `overclock_squad_{delete,get,list,save,spawn}`, `overclock_stack_get`, `overclock_status`, `overclock_task`, `overclock_vault_list`, `overclock_video_generate`, `overclock_workflow`, `overclock_workspace_{add,list}`.

Observação externa (Arms / Grok Bot), extraída do jsc:

`app_diagnostic_events`, `app_events`, `app_observe`, `app_observe_once`, `app_pane_contents`, `app_screenshot`, `app_status`, `app_watch`.

Pane: `pane_{list,read,read_many,spawn,spawn_many,write,write_many,wait_idle,wait_many,close,whoami,list_providers}`.

### 1.6 Nexus neste checkout (âncora)

| Peça | Evidência |
|---|---|
| Versão | `package.json:3` → `0.70.21` |
| Shell | Electron `^43.0.0` + Forge; **não** Tauri |
| Terminal | `@xterm/xterm` `^6.0.0` + `@xterm/addon-webgl` `^0.19.0` (`package.json:58-62`) |
| PTY | `@lydell/node-pty` + `src/main/pty/` + `native/darwin-pty-supervisor/` |
| Soft/hard panes | `src/shared/pane-limits.ts:10-11` → soft **80**, hard **100** |
| Adapters builtin | `src/adapters/builtin/`: agy, aider, claude, codex, deepseek, glm, grok, kimi, longcat, openclaude, opencode, qwen. **Sem `muse.json`.** |

---

## 2. Matriz de paridade (release notes 1.3.0 → 1.3.18)

Cada linha: o que a nota diz → status no Nexus → prova.

### 2.1 Headline 1.3 (“o motor”)

| Item | Status | Evidência Overclock | Evidência Nexus |
|---|---|---|---|
| **01 Motor OVERDRIVE** — terminal nativo Rust para todos os agentes | **FALTA** (arquitetura) | Binário `overclock` linka `alacritty_terminal-0.25.1` + `vte-0.15.0`; crate `src/overdrive_term/*.rs`; IPC `overdrive_spawn/write/feed/resize`. Sidecar: `isOverdrivePane`, `startOverdrivePoll`. | Terminal é xterm.js no renderer Chromium: `package.json:62`, `src/renderer/terminal/terminal-host.ts:3` (`WebglAddon`). Busca `overdrive` / `alacritty_terminal` em `src/` = só docs de análise e o comando “OVERDRIVE” do skill impeccable (`src/main/orch/impeccable-manifest.ts`), **não** um motor de terminal. |
| Pixel-cravado / fundo preto puro / scroll e resize perfeitos | **H** no Overclock; **PARCIAL** no Nexus | Notas de marketing. Binário tem `Term::resize`, `overdrive_scroll`, `overdrive_resize`. Sem prova de “pixel-perfect” nesta máquina além de crates Alacritty. | Resize/scroll: xterm + `terminal-render-policy.ts:44-49` (comentário cita o bug herdado: N panes = N repaints). Fundo/tema: `TERMINAL_THEME_IDS` (`settings-types.ts:28-34`). |
| **02 Escala 16/32 panes sem travar** — pipeline async, cache de vértices, VBO por pane, grid em ondas | **PARCIAL** (escala sim; VBO não) | Strings `warmPool`, `pacedBoot` no jsc; `overdrive_set_visibility`; control plane “no pipe do Rust (sem renderer)”. **Não** achei `VBO`/`vertex`/`wgpu` no binário — o “VBO por pane” das notas é **H**. | Caps: `pane-limits.ts:10-11` (80/100, acima de 32). Esconde/não pinta: `terminal-render-policy.ts:22-30` + `terminal-host.ts:1911`. WebGL: lease por foco (`webgl-lease.ts:1-14`, cap Chromium ~8–16 contextos). **Não** há `warmPool`/`pacedBoot` (`rg` em `src/**/*.ts` = 0 hits). |
| **03 Cofre + temas Escuro/Cinza/Claro** | **PARCIAL** | jsc: `vault:get/providers/saveSecret`, `overclock_vault_list`, `overclock_skin_{list,apply,get}` com ids `dark`/`gray`/`light`/`red` (rótulos Escuro/Cinza/Claro/Vermelho). Whisper local: `whisper-cli`/`whisper.cpp` + auto paths. | Cofre: `src/main/persistence/secrets-store.ts:8-16` (safeStorage/Keychain, `~/.nexus/secrets.enc`) + `media-keys.ts:11-16`. **Não** há `nexus_vault_list` (`rg nexus_vault_list` = 0). Temas: `settings-types.ts:28-34` = `nexus-pink-city`, `nexus-dark`, `nexus-light`, `dracula`, `solarized-dark`. **Não** há Cinza nem Vermelho de produto, nem `nexus_skin_*`. Whisper: `stt-service.ts:233-240` (probe Homebrew). |

### 2.2 v1.3.18 (o release instalado)

| Item | Status | Prova |
|---|---|---|
| Windows volta a abrir (pacote interno fora do empacotamento → “motor não reportou porta”) | **N/A-plataforma** / **FALTA** no nosso boot Electron | Overclock: string `o reportou porta` + `engine_probe` + `sidecar_retry` no binário Rust. Nexus não tem sidecar/porta: o main Electron **é** o motor (`src/main/main.ts`). Sem equivalente semântico. |
| Codex volta a abrir pane nos modos padrão e plano (CLI removeu um valor de aprovação que o app ainda mandava) | **PARCIAL — risco vivo** | Overclock 1.3.18 é exatamente este bug. Nexus ainda declara `untrusted: "untrusted"` em `src/adapters/builtin/codex.json:96-99` (`--ask-for-approval` modes `never` / `on-request` / `untrusted`). Se o Codex atual rejeita `untrusted`, **reproduzimos o bug que eles acabaram de corrigir**. Não executei o Codex desta máquina para provar a rejeição (**H alta**). Reconstrução governada: `autonomous-cli-policy.ts:365-469` (sandbox + `--ask-for-approval on-request`/`never`). |
| Cada host só recebe a flag que entende, inclusive ao reabrir pane | **FEITO** (spawn) / **PARCIAL** (reopen armazena argv do adapter) | `control-args.ts:3-8,19-48`: “a provider never gets a flag it doesn't understand”; modos vêm de `adapter.control.permission`. Persistência: `provider-config-store.ts:212-222` `controlArgsFor`. Flags por CLI: `claude.json:97-110`, `codex.json:94-110`, `agy.json:90-99` (só `--dangerously-skip-permissions` / `--sandbox`), `kimi.json:99-105` (só `--auto`). |
| Antigravity: lista com nome legível; modelo salvo desconhecido é limpo | **PARCIAL** | Overclock jsc: `[antigravity] unknown model slug, leaving settings.model untouched` **e** rewrite de `settings.json`. Nexus: adapter `agy.json:1-65` com ids crus (`gemini-3.7-flash-high`…); descoberta viva `model-discovery.ts:20-37` `parseAgyModelsOutput` (id, não label). `rg "unknown model slug"` em `src/` = 0. Não há limpeza automática de slug desconhecido. |
| Instalador Windows com a cara do produto | **N/A-plataforma** | Nexus tem Maker Squirrel (`forge.config.ts:10,199,392-396`) mas não foi inspecionado um instalador Windows branded nesta máquina. |
| Cada pane nasce sabendo quais contas ainda têm folga (Redline responde ao agente) | **PARCIAL** | Overclock: `redline_pick_account`, `OVERCLOCK_REDLINE_PICK`, `providerFromRedline`, `redlineNotice`; binário Redline **ausente** nesta máquina. Nexus: frota de quota no main (`quota-service.ts:1-6`) + MCP `nexus_quota_status` (`tools-instruments.ts:181-190`) — o orquestrador **consulta** o snapshot, o worker só vê o próprio provider. **Não** injeta folga no argv/env do pane no spawn (`rg quota` em `src/main/pty/` = 0). UI: `CostBadge.tsx`. |
| Pane sem conta escolhida usa a que ainda tem saldo; Redline fechado → abre igual, só avisa | **FALTA** (auto-pick) | Overclock: `providerFromRedline` + `Redline provavelmente fechado`. Nexus: failover/quota existem, mas não há “pick account with remaining headroom at birth”. `rg redline` em `src/` = 0. |
| Falha do servidor de licença diz “não deu pra confirmar” em vez de acusar falta de licença | **PARCIAL** | Overclock jsc: `license_unconfirmed` distinto de `no_license` / `license_denied`; copy “não consegui confirmar sua conta”. Nexus: `billing-types.ts:62-66` — `verified: false` **não bloqueia**, só informa falta de prova criptográfica. UI `AccountSection.tsx:230-236` não tem estado “não deu pra confirmar”; sem login mostra “só nesta máquina”. `rg license_unconfirmed` = 0. |

### 2.3 v1.3.17

| Item | Status | Prova |
|---|---|---|
| Windows: atalho npm reinterpretado pelo terminal engolia config interna (Codex/Claude não abriam) | **N/A-plataforma** | Nexus `path-resolver.ts:143` no win32 devolve `process.env.PATH`; no macOS sonda o login shell (`:139-158`). Sem o workaround `.cmd` do Overclock. |

### 2.4 v1.3.16

| Item | Status | Prova |
|---|---|---|
| Sem confirmação da assinatura a tela fala de sessão, não de compra | **PARCIAL** | `AccountSection.tsx:228,235,242`: “Conta local (sem login)” / “só nesta máquina” / pill `local` — não empurra checkout no chrome da sessão. Checkout existe (`BILLING_CHANNELS.checkout`, `billing-types.ts:77-80`) mas é ação explícita. |
| Assinatura vencida barra na porta com link pra renovar | **FALTA** (gate de porta) | `rg status === 'expired'` / `plan_required` na UI de boot = não achei. `license.status` é renderizado quando `active` (`AccountSection.tsx:232,244`). Não há tela de porta “renove para entrar”. |

### 2.5 v1.3.15

| Item | Status | Prova |
|---|---|---|
| `OVERCLOCK_BOT_MODE=1` no Linux: Home sem onboarding/consent/WhatsNew; updater `managedBy overclock-bot` | **FALTA** | `rg BOT_MODE` em `src/` = 0. Overclock: string `OVERCLOCK_BOT_MODE` no jsc; `managedBy` no updater Rust. |
| Diálogo onboarding sem fundo no Linux/WebKit | **N/A-plataforma** | Nexus é Chromium, não WebKitGTK. |
| Pane aberto por braço (MCP) traz a UI pro workspace e foca o pane | **PARCIAL** | Overclock Arms: `bin.js` + `index.js` (“vê a tela em JSON, dirige o wizard, delega a panes”). Nexus: `nexus_pane_spawn` (`tools-panes.ts:328`) existe; **não** há conector stdio/HTTP externo tipo Arms (`rg armsCommand` / `overclock-arms` em `src/` = 0). MCP Hub (`mcp-hub-core.ts:12-14`) é config-plane de servers **do usuário**, não um braço de orquestrador externo. |

### 2.6 v1.3.14

| Item | Status | Prova |
|---|---|---|
| Squad nasce no workspace que você mandou | **PARCIAL** | Nexus tem `ProjectExecutionScope` + spawn com cwd; análises anteriores já trataram drift de workspace. Não re-provei o bug “squad no workspace errado” nesta passagem. |
| Trava de skill que sumia agora NEGA em vez de destravar em silêncio | **FALTA** (fail-open vs fail-closed no lock) | `rg skillLock` / `skill_lock` em `src/` = 0. Overclock jsc também não spitou `skillLock` nesta extração — o comportamento está no bytecode. Nexus: skills governadas via `allowedSkills` + `withGuidedSkillDefaults` (`builtin-squads.ts:61-68`); ausência no modo governado = **nenhuma** skill (fail-closed), o que é *outra* trava, não o “marcador apagado ⇒ unlock”. |
| Squads de fábrica só nos CLIs que entregam a receita (claude, codex, kimi, grok) | **PARCIAL** | Nexus builtins (`builtin-squads.ts:14-21`): orquestrador Claude + worker Codex; Pet Studio = Codex único. Kimi/Grok **não** entram no roster autônomo desta release (comentário explícito). Overclock factory em `~/.overclock-app/squads.json`: 5 squads. |
| Dev: pane de squad enxerga só o MCP do Overclock nos 5 CLIs | **PARCIAL** | Nexus injeta MCP por CLI (`cli-mcp-inject.ts`) com allowlist; isolamento é por sessão/sandbox, não “só o server Nexus” como doutrina única. |
| Sessões voltam vinculadas às missões | **FEITO** | `pane-registry.ts`, `mission-reopen`, `pty-ipc-mission-resume.test.ts`. |
| Fechar pane não deixa processo de CLI zumbi | **FEITO** | `pty-descendant-termination.ts:1-40` (grace 2s, snapshot `ps`, kill da árvore). |

### 2.7 v1.3.13

| Item | Status | Prova |
|---|---|---|
| Catálogo de agentes e skills volta a aparecer (marcador de pasta apagado derrubava detecção de recursos embutidos) | **FEITO** (caminho diferente) | Nexus: `catalog.ts:35+`, `tools-instruments.ts:26` `nexus_skills_inventory`. Recursos em `assets/skills/` (17 `SKILL.md`). Não depende de um “marcador de pasta” estilo Overclock. |
| 49 arquivos de arsenal restaurados (crews cinema, cinema-site, qa-swarm, qa-vision, squad-former, absurd-landing) | **FALTA** (playbooks) | Overclock bundle: 72 arquivos nessas árvores. Nexus `rg cinema-site|qa-swarm|squad-former|absurd-landing` em `src/` = só docs de análise. Squads builtins: `nexus-plan`, `nexus-story-impl`, Pet Studio (`builtin-squad-ids.ts:5-6`). |
| Squads de fábrica sobem completas (4 workers dos presets) | **PARCIAL** | Nexus builtins sobem; não são os presets cinema/qa. |
| Divisor entre panes volta a arrastar | **FEITO** | `PaneGrid.tsx:2,12` (`react-resizable-panels`). |
| Fim do pane preto do nada e da piscada ao redimensionar | **PARCIAL** | Overclock: Overdrive nativo. Nexus: `webgl-lease.ts:3-7` (contextlost) + `terminal-host.ts:256-260` `onContextLoss` → fallback DOM. Comentário em `terminal-render-policy.ts:44-49` documenta o bug de repaint em massa. |
| Login não depende de arquivo legado; sessão só em `~/.overclock-app` | **FEITO** (equivalente `~/.nexus`) | `secrets-store.ts:11`; `AccountSection.tsx:432` menciona `~/.nexus/license.json`. |
| Tela de Catálogo mostra o que é do Overclock | **N/A** / branding | Nexus tem catálogo próprio (`catalog.ts`). |
| Selo PRINCIPAL sai do cabeçalho do pane | **FEITO** (não existe o selo) | `rg PRINCIPAL` / `isLeader` em `src/renderer` = 0 para badge de pane. |

### 2.8 v1.3.12

| Item | Status | Prova |
|---|---|---|
| Receitas mostram o erro real (caminho com acento no Windows) | **N/A-plataforma** | Nexus tem `nexus_recipe_propose` (`tools-domain.ts:773`), **não** `nexus_recipe_list/get` (`rg` = 0). |
| `providers.json` nunca é apagado (quarentena + backups órfãos) | **PARCIAL** | Overclock: strings `[providers] write on hold… preserved (OVKA-29)` + `.providers-encryption-broken` nesta home. Nexus: `provider-config-store.ts` + `secrets-store.ts` (não é o mesmo arquivo `providers.json`). |
| Pós-crash cada pane volta com a SUA sessão | **FEITO** | Resume Codex/Claude: `pty-ipc-mission-resume.test.ts`; `spawn.interactive` + `resumeArgs` nos adapters. |
| Workers seguem com a janela minimizada (control plane sai do renderer) | **FEITO** (main, não Rust) | Overclock: `[overdrive] control plane no pipe do Rust (sem renderer)`. Nexus: orquestração e PTY vivem no **main** (`src/main/orch`, `src/main/pty`); `agent-awake-service.ts:5-10` impede sleep enquanto agentes rodam. Renderer só pinta. |
| Worker que morre acorda o orquestrador (canal de morte do Overdrive) | **PARCIAL** | Overclock: canal nativo Overdrive. Nexus: `pane-registry.ts:2025` mortalidade; `worker-handoff-ttl.ts:36-37` (30s, **default-on** `feature-flags.ts:151-160`); **não** há pipe Rust de death. |
| Auto-update Windows e Linux (6 plataformas no canal) | **PARCIAL** | Nexus: `src/main/updater.ts:1` (`electron autoUpdater` + Squirrel). macOS é o canal vivo. Forge: DMG + Deb + Rpm (`forge.config.ts:390-403`). Sem `tauri-plugin-updater`. Sem AppImage/AppRun. |
| Linux abre sem gambiarra (AppRun autossuficiente + tar.gz) | **FALTA** | `rg AppImage|AppRun` no produto = 0 (só menção NVDA em skill impeccable). |
| Acessibilidade NVDA | **FALTA** | `rg NVDA` em `src/` = 0. Há `aria-label` pontual (`App.overlays.test.tsx:97-118`). |
| Missão criada por agente nasce no workspace certo | **PARCIAL** | Mesmo comentário de 1.3.14. |

### 2.9 v1.3.11 – 1.3.9 (Arms)

| Item | Status | Prova |
|---|---|---|
| Arms stdio nunca trava (JSON puro, prazo 8s, retry, sobrevive a update) | **FALTA** (não temos Arms) | `arms-mcp/proxy.js:18-22` `ARMS_FETCH_TIMEOUT_MS = 8_000`; `bin.js` stdout = só JSON-RPC. |
| Wizard por tools arma o fire (missão Livre pelo orquestrador externo Grok) | **FALTA** no conector externo | Nexus tem wizard/missão interna (`nexus_mission_create` `tools-domain.ts:224`). Arms é o canal **de fora**. |
| Erro de update não aparece como problema de licença | **PARCIAL** | Updater e billing são módulos separados (`updater.ts`, `billing-ipc.ts`). Sem o bug reportado, sem o enum `license_unconfirmed` deles. |
| Arms aceita cliente HTTP sem sessão (Grok Bot): token do conector = sessão; Origin/Accept flexíveis | **FALTA** | `proxy.js` modo stateless `application/json`; `arms.json` nesta home. Nexus MCP do pane exige o lease interno. |
| **FEAT Overclock Arms** + Settings › Conectores › Grok Bot (gerar/copiar/revogar token) | **FALTA** | Pasta `arms-mcp/` no app; UI de token no Overclock (não extraímos a UI, mas `rotateArmsToken`/`revokeArmsToken`/`revealArmsToken` estão no jsc). Nexus: sem seção Conectores/Grok Bot. |
| `app_events` fila com cursor (`pane.handoff`, `dialog.*`, `skin.changed`) | **FALTA** | jsc descreve a fila. Nexus: `nexus_handoff_list` (`tools-handoff.ts:494`) é a caixa postal de workers, **não** um cursor de eventos de UI. `rg app_events` em `src/` = 0. |
| Uma pintura por redimensionamento | **PARCIAL** | `terminal-render-policy.ts:44-49`. |
| Abertura de panes por CPU/resultado (`warmPool`/`pacedBoot`) | **FALTA** | `rg warmPool|pacedBoot` em `src/` = 0. |
| 4º tema Vermelho + skins com rótulo da tela | **FALTA** | Temas em `settings-types.ts:28-34`; sem `red`. |

### 2.10 v1.3.8

| Item | Status | Prova |
|---|---|---|
| 16 panes assentam a grade em ~1s (era 5s) | **H** (eles) / **PARCIAL** (nós) | Não medi latência do Overclock. Nexus: caps 80/100 + adaptive hold. Sem pacedBoot. |
| Arrastar divisor mexe só nos dois panes vizinhos | **FEITO** | `react-resizable-panels` em `PaneGrid.tsx:2`. |
| App parado: 0,6 consulta/s no lugar de 16 | **H** | Não extraí o número 0,6 do jsc nesta passagem. Nexus tem coalesce de output (`terminal-render-policy.ts:28`). |
| MCP local exige credencial e recusa navegador | **PARCIAL** | Lease MCP do Nexus é autenticado por sessão de pane; MCP Hub mascara segredos (`mcp-hub-secrets.ts:14`). |
| Worker que termina não perde o resultado quando a sessão MCP cai | **FEITO** | Outbox + `nexus_handoff_submit` (`tools-handoff.ts:139`). |
| Pane kimi nasce trabalhando (pergunta “confiar na pasta” engolia a 1ª tarefa) | **PARCIAL** | Kimi yolo = `--auto` (`kimi.json:102-104`). Não achei `--skip-trust` no adapter Kimi do Nexus. Overclock jsc lista `--skip-trust` na sopa de flags. |
| Falar depois de trocar de workspace vai pro pane certo | **PARCIAL** | Voice/Jarvis no Nexus (`src/main/voice`, `src/main/jarvis`). Não re-provei o bug de retarget. |
| Grade realinha ao fechar pane | **FEITO** | `split-tree.ts` + `PaneGrid.tsx`. |
| Fixar chefe em duas missões não quebra layout | **PARCIAL** | Não reproduzi. |
| Seleção de texto acompanha a linha; bloco retangular só com Shift | **H** / **PARCIAL** | Comportamento xterm.js default; não há modo bloco documentado. |
| Pane invisível não desenha; Codex sem processo extra | **PARCIAL** | Invisível: `terminal-render-policy.ts:22-30`. “Codex sem processo extra”: Overclock específico do Overdrive; Nexus spawn = 1 PTY por pane. |
| Refresh de sessão no menu do pane | **PARCIAL** | Resume existe no spawn; menu “Refresh de sessão” não foi buscado como label. |
| **Tab cicla entre panes** | **FALTA** | `shortcuts.ts:84-90` = `mod+1-9` foca o N-ésimo. `rg cyclePane|focusNextPane|Tab.*pane` em `src/renderer` = 0. |
| Instaladores verificados por assinatura | **FEITO** (macOS) | Gate de release + notarização (`scripts/release-candidate-gate.mjs`, `docs/RELEASE-CHECKLIST.md`). |
| Código de pareamento não vaza no log | **PARCIAL** | Remote bridge tem `rotate_pairing` (`tools-domain.ts:812`). Não auditei logs nesta passagem. |
| Segredos no keychain e leitura de arquivo contida no workspace | **FEITO** | `secrets-store.ts:8-16`; sandbox PTY (`advisory-process-sandbox.ts`). |

### 2.11 v1.3.7 – 1.3.6

| Item | Status | Prova |
|---|---|---|
| Panes pretos se recuperam; se não, troca de motor gráfico sozinho | **PARCIAL** | Nexus: contextlost → dispose WebGL → DOM (`terminal-host.ts:256-260`). **Não** há segundo motor (Overdrive/OpenGL nativo). Sem toast de “troquei o motor”. |
| Harness não derruba o app (catálogo antigo curado sozinho) | **PARCIAL** | Catálogo Nexus (`catalog.ts`) com timeouts/limites (`:109-172`). |
| Terminal em branco no Mac Intel (testa se consegue desenhar e troca de método) | **PARCIAL** | WebGL lease falha → DOM. Overclock `engine_probe` no Rust. |
| Chefe do agêntico nasce no CLI do piloto | **PARCIAL** | Squad builtins fixam Claude+Codex (`builtin-squads.ts:17-20`), não “CLI do piloto”. |
| Agente instalado pelo Cardápio vai pro CLI escolhido | **PARCIAL** | Catalog install existe (`nexus_catalog_install` `tools-domain.ts:701`). |
| Cada workspace lembra o pane em uso | **FEITO** | `active-workspace.ts` + persistência de layout. |
| App não morre por mensagem malformada na conexão interna | **PARCIAL** | Preload/IPC com Zod em vários canais; não provei o bug. |
| Arquivo grande arrastado avisa o limite | **PARCIAL** | `agent-attach.ts`; não conferi o cap de bytes nesta passagem. |
| Login não culpa a internet quando quem parou foi o motor | **PARCIAL** | `api-client.test.ts:71` — sem sessão no Keychain devolve 401 sintético **sem rede**. |
| Retomar conversa Claude não falha com “Transcript não encontrado” | **PARCIAL** | Resume args no adapter Claude; não reproduzi o erro. |

### 2.12 v1.3.5

| Item | Status | Prova |
|---|---|---|
| Sessões tmux do servidor viram panes | **FEITO** | `nexus_remote_tmux_list` / `nexus_remote_spawn` (`tools-domain.ts:845-862`); `persistent-session.ts:3-50`. Flag tmux fail-closed (`feature-flags.ts:90,323-329`). |
| Grok e outras CLIs do servidor abrem pelo + PANE do workspace SSH | **FEITO** | `nexus_remote_cli_detect` (`tools-domain.ts:832-842`); `src/main/remote/ssh/`. |
| Visão do host redesenhada (tabs MISSÕES/TERMINAIS) | **PARCIAL** | UI Nexus própria (Home/grid/quadro); não é o redesign Overclock. |
| Crash reporting com consentimento (Sentry) | **FALTA** | Overclock: `@sentry/node` no sidecar `package.json`; DSN no jsc; `privacy.crashReportingEnabled` nesta home. Nexus: `rg @sentry` em `src/` = 0. |
| Hooks Codex/Grok no Windows | **N/A-plataforma** | Hooks Nexus em `src/main/agent-hooks/` (macOS-first). |
| Excluir pane salvo exclui de verdade; restaurar reanexa | **FEITO** | Close + resume tests. |
| Worker não abre panes-netos (fim da cascata Codex); prompt de nascimento + permissões herdadas | **FEITO** (doutrina) | `builtin-squads.ts:38-58`: worker `allowedTools: []` — sem spawn cruzado. `autonomous-cli-policy.ts` herda perfil. |
| Rodinha do mouse rola histórico de TUIs | **PARCIAL** | xterm.js; Overdrive tem `overdrive_scroll` nativo. |
| Perguntas de esclarecimento usam o seletor nativo de cada CLI | **PARCIAL** | `nexus_clarify` (`tools-domain.ts:1199`); seletor nativo por CLI não foi mapeado 1:1. |
| Badge Principal único por missão; sessões órfãs marcadas e encerráveis | **PARCIAL** | Sem badge PRINCIPAL. Mortalidade/órfãs: `pane-registry.ts`. |

### 2.13 v1.3.4 – 1.3.1

| Item | Status | Prova |
|---|---|---|
| Sessão para de morrer sozinha (login sobrevive ao dia) | **PARCIAL** | Keychain + `license.json`; não medi TTL de sessão. |
| Muse Code chega como agente | **FALTA** (spawn) | Overclock jsc: `Muse Code`. Nexus: auth blob `subscription-auth.ts:653-799` e `MODEL_DISCOVERY_INVENTORY.muse` (`model-discovery.ts:197`) — **sem** `src/adapters/builtin/muse.json` (`ls` da pasta; `rg muse` em `src/adapters` = 0). Logo de UI existe (`ProviderLogo.tsx` muse). Não dá para abrir pane Muse. |
| Abrir pane a partir de grok/opencode/cursor/copilot/kiro/muse clona o CLI certo (antes virava Claude) | **PARCIAL** | Adapters grok/opencode existem. cursor/copilot/kiro/muse **não** estão em `src/adapters/builtin/`. |
| Hooks e handoff automático em qualquer CLI (comando de hook não depende de aspas/shell) | **PARCIAL** | Hooks para claude/codex (e outros no listener); produção registra o conjunto governado. |
| Pane não fica com área preta | **PARCIAL** | Ver 1.3.13/1.3.7. |
| Pane novo nasce pronto pra digitar | **FEITO** | Spawn PTY interativo. |
| Browser com viewport de celular **e tablet** | **PARCIAL** | Mobile: `browser-manager.ts:143-149` (≤480 → 844px, UA iPhone). `rg tablet` em `src/main/browser` = 0. |
| Viewer de arquivo com copiar código/texto | **PARCIAL** | Editor/files: `files-store.ts:34+`, `ProductPanelBodies.tsx`. Não achei ação “copiar código” dedicada no viewer (`rg copyCode` = 0). |
| Barra de rolagem padronizada | **PARCIAL** | CSS do renderer (`DESIGN.md` tokens). |
| Deps com falha de segurança atualizadas | **PARCIAL** | `npm run release:security` (`package.json:24`). Não comparei o audit desta data com o deles. |
| Windows: panes herdam PATH do sistema | **FEITO** (código) | `path-resolver.ts:143`. |
| Fechar pane não estica vizinhos nem derruba o motor | **FEITO** | Layout tree + PTY no main. |
| Internet instável não desloga (licença offline por assinatura em disco) | **PARCIAL** | `billing-types.ts:62-66` + `NEXUS_LICENSE_PUBKEY`. Overclock: `license-claim.json` nesta home. |
| Windows: clicar em caminho de arquivo abre o arquivo | **FALTA** (terminal) | `rg registerLinkProvider|OscLink` em `src/` = 0. `shell.openPath` existe para notices/deliverable (`window.ts:188`), **não** como link provider do xterm. |

### 2.14 v1.3.0 (nascimento do OVERDRIVE + o resto do “motor”)

| Item | Status | Prova |
|---|---|---|
| Motor OVERDRIVE | **FALTA** | Ver §2.1. Decisão registrada: **ficar no Electron** (`docs/analysis/2026-08-05-tauri-spike.md:3,28-36`). |
| Servidores/VPS beta (IP+user+senha, cria chave, senha descartada; workspace do servidor na Home) | **PARCIAL** | Nexus SSH: `src/main/remote/ssh/` (alias, bootstrap de chave, `ssh-config-sync`). MCP `nexus_remote_*`. Não provei o fluxo “senha digitada e descartada” 1:1 com o deles. |
| Sensibilidade de scroll, Shift+↑/↓ no histórico, tela cheia por pane | **PARCIAL** | xterm search/scroll nativos; atalhos em `shortcuts.ts` **não** listam Shift+↑/↓ de histórico nem fullscreen por pane. |
| Privacidade/conformidade (zero telemetria sem consentimento, licenças de terceiros no app, endereços de servidor nunca em tela/log) | **PARCIAL** | Nexus: `THIRD_PARTY_NOTICES.md`, sem Sentry. Overclock: `THIRD-PARTY-LICENSES.html` no bundle + Sentry **com** consent (`privacy.crashReporting*`). |
| 16–32 panes fluidos (pipeline async, cache de vértices, VBO, deadlock do runtime morto) | **PARCIAL** | Ver §2.1. Caps Nexus 80/100. VBO = **H** no Overclock. |
| Temas Escuro/Cinza/Claro | **PARCIAL** | Dark/light sim; Cinza não. |
| Cofre de integrações (API keys num lugar só; voz local com whisper auto-detectado e pré-aquecido) | **PARCIAL** | Cofre split: media + voice + MCP Hub. Whisper probe: `stt-service.ts:233-240`. Pré-aquecimento contínuo estilo Overclock **não** confirmado (STT local ainda spawna subprocesso por call — `stt-service.ts` timeout 30s). |
| Atalhos regraváveis, ⌘N clona último pane, caminhos clicáveis, criar/excluir na tela de arquivos | **PARCIAL / FALTA** | Atalhos: catálogo único **não** regravável (`shortcuts.ts:1-16`). ⌘N = **nova missão** (`shortcuts.ts:51-56`), **não** clona pane (`rg cloneLast|duplicatePane` = 0). Caminhos clicáveis no terminal: **FALTA**. Files: `files-store.ts` abre/salva. |
| Settings e modais redesenhados no design system | **FEITO** (o nosso) | `DESIGN.md` + `src/renderer/components/settings/`. Não é o DS do Overclock. |

---

## 3. Gaps reais, ordenados por impacto para a próxima release

Só o que muda produto visível ou risco de boot. Cada item: o que é → como o Overclock resolve (evidência) → custo no nosso código → risco.

### G1 — Motor de terminal ainda é xterm.js no Chromium (o “1.3” deles)

**O que é.** A 1.3 inteira é vendida como troca de coração: pintar 16–32 agentes sem congelar. O instalado **é** Tauri 2.11.2 + crate `overdrive_term` (Alacritty 0.25.1) falando IPC nativo com o sidecar Node.

**Como eles resolvem.** Processo `overclock` pinta o grid; sidecar só orquestra. `overdrive_set_visibility` + control plane “no pipe do Rust”. `warmPool`/`pacedBoot` no jsc.

**Custo no Nexus.** Trocar `src/renderer/terminal/terminal-host.ts` + addons xterm por um host nativo (Rust ou GPU próprio) **e** um canal main↔native. Mexe em PTY (`src/main/pty/`), preload, scheduler de output, WebGL lease, gates CDP (`scripts/release-candidate-gate.mjs` dirige Chromium). O spike de 2026-08-05 já recusou Tauri (`docs/analysis/2026-08-05-tauri-spike.md:28-36`): WKWebView sem CDP cega o gate de release.

**Risco.** Altíssimo. É uma release de plataforma, não um patch. **Não** entra na próxima versão de produto se o objetivo é lançar. Mitigações que **já temos**: caps 80/100, park de pane invisível, lease WebGL, awake service.

**Verificado:** arquitetura. **H:** “VBO por pane” / “pixel cravado” — não achei `wgpu`/`VBO` no binário; o que achei foi Alacritty + OpenGL surface AppKit.

### G2 — Overclock Arms (orquestrador de fora: Grok Bot / Cursor)

**O que é.** Conector MCP stdio/HTTP para quem **não** mora num pane: vê a tela em JSON, dirige o wizard, spawna panes, lê `app_events` com cursor. Token gerável em Settings. 1.3.9–1.3.11.

**Como eles resolvem.** Pacote **legível** `Contents/Resources/sidecar/arms-mcp/`: `bin.js` (stdout = só JSON-RPC), `proxy.js` (`ARMS_FETCH_TIMEOUT_MS = 8000`, modo stateless, retry, desktop fechado = estado e não crash). Home: `arms.json` / `arms.token`. jsc: `app_observe`, `app_events` (`pane.handoff`, `skin.changed`).

**Custo no Nexus.** Novo server MCP de **host** (não o MCP injetado no CLI): `src/main/orch/mcp-server.ts` + um bin `nexus-arms` (ou reusar o sidecar HTTP já interno). Tools: `app_observe` / `app_events` (cursor) + `pane_*` já existentes. UI Settings › Conectores. Auth por bearer, Origin/Accept flexíveis.

**Risco.** Médio. Superfície de ataque nova (token = sessão). Precisa do mesmo rigor do lease MCP atual. Alto valor: é o que permite Grok/Cursor **dirigirem o app** sem print.

**Verificado:** código Arms no disco + descritor sidecar apontando para `arms-mcp/bin.js`.

### G3 — Folga de conta no nascimento do pane (Redline / auto-pick)

**O que é.** 1.3.18: o pane **já nasce** sabendo quais contas daquele CLI ainda têm saldo; se ninguém escolheu conta, pega a que tem folga; Redline fechado não impede o boot.

**Como eles resolvem.** MCP `redline_pick_account` + env `OVERCLOCK_REDLINE_*` + fallback `redline-last-good.json` (presente nesta home). App Redline **não** está em `/Applications`.

**Custo no Nexus.** Ligar `quota-service.ts` + `nexus_quota_status` (`tools-instruments.ts:181`) ao **spawn** (`provider-config-store.ts` / `spawn-authority` / `pty-manager`): escolher accountId com `usedRatio` baixo **antes** do argv. Aviso se o probe falhar (não bloquear). Sem copiar o app Redline.

**Risco.** Baixo/médio. Probe errado pode mandar trabalho para conta esgotada (já acontece hoje por omissão). Não precisa de processo extra.

**Verificado:** quota MCP existe mas `rg quota` em `src/main/pty/` = 0.

### G4 — Valor de aprovação Codex possivelmente obsoleto (`untrusted`)

**O que é.** A nota 1.3.18 é literal: o CLI Codex **removeu** um valor de aprovação que o app ainda mandava, e o pane não abria nos modos padrão/plano.

**Como eles resolvem.** (Bytecode.) Strings de flags no jsc: `--ask-for-approval` ao lado de `on-request` / `never`.

**Custo no Nexus.** `src/adapters/builtin/codex.json:96-99` ainda tem `"untrusted": "untrusted"`. Confirmar contra o Codex instalado (`codex --help` / erro de argv) e dropar o modo se o CLI recusar. Ajustar `control-args.ts` + `autonomous-cli-policy.ts` + testes.

**Risco.** Baixo de código, **alto de produto** se for o mesmo bug: Codex some do grid. **H alta** — não executei o Codex nesta passagem.

### G5 — Playbooks de fábrica (cinema, qa-swarm, squad-former, absurd-landing)

**O que é.** 1.3.13 restaurou o arsenal; 1.3.14 restringe factory aos CLIs da receita. São **receitas executáveis** (PLAYBOOK + agents + skills), não só um squad de 2 papéis.

**Como eles resolvem.** 72 arquivos em `Contents/Resources/resources/{cinema,cinema-site,qa-swarm,qa-vision,squad-former,absurd-landing,arsenal}`. `squads.json` vivo com 5 factory ids.

**Custo no Nexus.** Portar PLAYBOOKs para `assets/skills/` + `builtin-squads.ts` / `src/adapters/builtin` allowlists. Não copiar branding “overclock-*” dos nomes. Ligar em `nexus_catalog_*` / `nexus_recipe_*` (`recipe_list/get` ainda **faltam**: `rg nexus_recipe_list` = 0).

**Risco.** Médio (conteúdo + roster). Baixo de plataforma.

### G6 — Caminhos clicáveis, Tab cicla panes, ⌘N clona último pane, atalhos regraváveis

**O que é.** 1.3.0 + 1.3.8: higiene de uso diário que a nota trata como óbvia.

**Como eles resolvem.** (Bytecode + Overdrive mouse/selection.)

**Custo no Nexus.**

- Link provider no xterm: `terminal-host.ts` + `shell.openPath` já em `window.ts:188` (reusar o sink, não inventar IPC).
- Tab: entrada em `shortcuts.ts` + handler em `App.tsx` (hoje só `mod+1-9`, `shortcuts.ts:84-90`).
- ⌘N hoje é missão nova (`shortcuts.ts:51-56`) — **não** copiar cegamente; ou outro atalho (`mod+shift+N` já é missão rápida no comentário).
- Remap: persistir override em `settings-types.ts`.

**Risco.** Baixo. Conflito de atalho com CLIs TUI (Tab) precisa de “só quando o pane não está em raw mode / quando o grid tem foco de chrome”.

### G7 — `app_events` / observação JSON da tela (sem print)

**O que é.** 1.3.9: fila com cursor para o orquestrador externo saber que um pane acabou **sem screenshot**.

**Como eles resolvem.** Tools `app_events`, `app_observe`, `app_observe_once`, `app_watch` no jsc.

**Custo no Nexus.** Event bus no main (já há handoff store + agent-status). Expor cursor estável. Complementa G2.

**Risco.** Médio (vazamento de PII se o filtro for frouxo). O jsc deles promete omitir output/prompts/segredos.

### G8 — Cofre único exposto + skins de produto + Sentry com consentimento

**O que é.** Headline 03 + 1.3.5 crash reporting + 1.3.9 4º tema.

**Como eles resolvem.** `overclock_vault_list` + `overclock_skin_*` + `@sentry/node` + toggle `privacy.crashReportingEnabled`.

**Custo no Nexus.** Unificar UI de `media-keys.ts` + `voice-secrets` + MCP Hub numa tela “Cofre”; tool `nexus_vault_list` (hoje **não existe**). Skins: ids `gray`/`red` em `settings-types.ts` + tokens em `base.css`. Sentry: opt-in no mesmo bloco de privacy; **não** ligar DSN sem consentimento.

**Risco.** Cofre = médio (já temos Keychain). Sentry = médio (telemetria). Skins = baixo.

### G9 — Muse como pane de verdade; AGY limpa modelo desconhecido

**O que é.** 1.3.3 Muse; 1.3.18 AGY labels + purge de slug.

**Custo.** Novo `src/adapters/builtin/muse.json` (auth já em `subscription-auth.ts:653`). AGY: persistir label na descoberta (`model-discovery.ts:20-37`) e recusar/limpar default inválido no store.

**Risco.** Baixo.

### G10 — Itens de plataforma que **não** pagam esta release (macOS-first)

Windows branded installer, AppRun Linux, NVDA, atalho npm `.cmd`, “motor não reportou porta”, BOT_MODE Linux. Evidência: nosso `package.json` / Forge DMG é o canal vivo; Overclock 1.3.18 nesta máquina é **darwin-arm64**.

**Risco de ignorar:** se a próxima versão **prometer** Windows/Linux no mesmo nível, estes viram P0. Hoje não são o gap que impede um 0.71 macOS.

---

## 4. Proposta de escopo da versão nova (Nexus 0.71)

Premissa: **não** reescrever o terminal em Rust nesta versão. O Overclock 1.3 é um motor; o Nexus 0.70.21 já tem orquestração, sandbox, quota, remote SSH e uma superfície MCP **mais larga** que a deles (browser, git, lsp, files, worktree, context doctor, instruments). O que ainda “está para trás” de forma **visível** é (a) o conector de fora, (b) higiene de CLI/spawn que eles acabaram de corrigir em 1.3.18, (c) polish de grid/cofre/skins, (d) playbooks de fábrica.

### Entra (corte para lançar)

1. **Codex argv (G4)** — confirmar e dropar valor de aprovação morto. Barato, evita o bug da nota 1.3.18.
2. **Quota no nascimento (G3)** — `nexus_quota_status` já existe; ligar no spawn + fallback “abre mesmo, avisa”.
3. **Arms mínimo (G2 + G7)** — bin stdio JSON-RPC + token em Settings + `app_observe`/`app_events` (cursor) em cima de `pane_*` / `handoff_list` já existentes. Sem isso o Grok Bot continua cego ao grid.
4. **Higiene de grid (G6)** — caminhos clicáveis no xterm; Tab cicla panes (com escape para TUI); atalho de clonar último pane **sem** roubar ⌘N da missão.
5. **AGY model slug (G9 parcial)** — limpar default desconhecido; labels na lista.
6. **Cofre na Settings + `nexus_vault_list` (G8 parcial)** — um lugar só, sem novo crypto (reusar `secrets-store.ts`).
7. **Copy de licença (1.3.16/1.3.18)** — distinguir “não confirmou” de “não tem licença”; não acusar falta quando o verify caiu.

### Fica de fora (e por quê)

| Fora | Por quê |
|---|---|
| **OVERDRIVE / Tauri / VBO** (G1) | Spike 2026-08-05: CDP do gate morre no WKWebView; sidecar Node volta. Caps 80/100 + WebGL lease já atacam o sintoma “32 panes travam”. Revisitar **depois** de gate CDP-free. |
| Playbooks cinema/qa-swarm completos (G5) | Conteúdo grande; não bloqueia o motor. Pode ser 0.72 se o catálogo já instalar skills. |
| Muse adapter completo | Auth existe; spawn é um JSON. Pode entrar se sobrar fatia — não é o 1.3.18. |
| Sentry | Consent + DSN + policy de PII. Não é gap de lançamento macOS. |
| NVDA / AppRun / instalador Windows chique / BOT_MODE | Canal desta máquina e deste repo é macOS. Sem promessa Windows/Linux nesta versão. |
| 4º tema Vermelho / skins MCP `skin_apply` | Cosmético. Dark/light/pink-city cobrem o produto. |
| Discord RPC | Sidecar deles tem `@xhayper/discord-rpc`; `config.json` tem a key. `rg discord-rpc` no Nexus = 0. Não é gap de IDE. |
| Redline.app como processo irmão | Não está instalado aqui; a folga já pode sair da `quota-service` sem o binário deles. |

### Onde o Nexus **já está à frente** (não copiar para trás)

Verificado neste checkout, não é slogan:

- Superfície MCP interna: browser (10+ tools, `tools-browser.ts`), git, lsp, files, worktree, context doctor, instruments (`nexus_quota_status`, `nexus_skills_inventory`, `nexus_cli_inventory`).
- Sandbox OS (Seatbelt/Bubblewrap) em `src/main/pty/` — o spike Tauri registrou que o Overclock **deixou** isso para trás na migração.
- Caps de pane 80/100 vs. marketing 32.
- Receipt chain / attestation (análises 2026-08-05; ainda no código).
- Mobile companion + `server/` de billing (o Overclock é desktop+sidecar).
- Decisão consciente de **não** migrar o shell (`2026-08-05-tauri-spike.md`).

---

## 5. Achado vs hipótese (caixa explícita)

**Achado verificado**

- Overclock instalado = **1.3.18**, Tauri 2.11.2, **sem asar**, sidecar bytenode 3.9 MB, Arms JS legível, arsenal 72 arquivos, sidecar vivo na porta 51737, home `~/.overclock-app` com Arms/Redline files/vault/keystore.
- Overdrive = crate `overdrive_term` + `alacritty_terminal-0.25.1` + `vte-0.15.0`.
- Nexus 0.70.21 = Electron 43 + xterm 6 + pane-limits 80/100 + quota MCP + control-args por adapter + remote tmux/SSH + secrets Keychain + **sem** Arms/app_events/BOT_MODE/Sentry/muse.json/VBO/warmPool.
- `codex.json` ainda lista modo `untrusted`.
- Redline.app **não** está em `/Applications`.

**Hipótese (não vender como fato)**

- “Cache de vértices e VBO por pane” — **não** apareceu no binário; pode ser marketing ou código sem essas strings.
- Codex `untrusted` **quebra** o boot hoje — alto, mas não executei o CLI.
- Tempo de assentamento “16 panes em ~1s” — não medi.
- “0,6 consulta/s com app parado” — não extraí o número do jsc.
- Skill-lock fail-closed do 1.3.14 — não localizei o identificador no bytecode nesta extração.
- Paridade de “squad no workspace certo” / “falar depois de trocar workspace” — não reproduzi runtime.

**Não inspecionado de propósito**

- Conteúdo de `providers.json` / `session.json` / tokens (segredos).
- Comportamento GPU em 32 panes (não abri os dois apps lado a lado para FPS).
- Instaladores Windows/Linux do Overclock (esta máquina tem só o `.app` macOS).

---

## 6. Como reproduzir a inspeção (somente leitura)

```bash
plutil -p /Applications/Overclock.app/Contents/Info.plist | rg 'CFBundleShortVersionString|CFBundleIdentifier'
otool -L /Applications/Overclock.app/Contents/MacOS/overclock
strings /Applications/Overclock.app/Contents/MacOS/overclock | rg 'overdrive_|alacritty_terminal|tauri-2'
strings /Applications/Overclock.app/Contents/Resources/sidecar/dist/index.jsc | rg 'warmPool|OVERCLOCK_BOT_MODE|app_events|redline_pick|license_unconfirmed'
ls /Applications/Overclock.app/Contents/Resources/sidecar/arms-mcp
find /Applications/Overclock.app -name '*.asar'   # vazio
# home: keys only
python3 -c "import json; print(sorted(json.load(open('/Users/cleofasrocha/.overclock-app/config.json'))))"
```
