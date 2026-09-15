# Delta 1.3.18 → 1.3.23 — inventário de portabilidade Overclock → Nexus

> Destilação do `/Applications/Overclock.app` **1.3.23** (CFBundleVersion 1.3.23, arquivos datados 2026-09-09), feita em 2026-09-15.
> Baseline: dossiê da 1.3.18 (`overclock-13318-dossie-portabilidade.md`), plano (`overclock-13318-plano-execucao.md`), gap analysis (`2026-08-31-overclock-1318-gap-analysis.md`) e o extract de 102 arquivos (`overclock-13318-extract/`).
> Clones desta rodada: [`overclock-1323-extract/`](overclock-1323-extract/) (gitignored por `.gitignore` local, exceto `sidecar-tools-runtime.json`, que é versionável).

---

## 1. Método e evidência

**Regras respeitadas:** nada foi escrito/movido/assinado em `/Applications/Overclock.app`; a GUI do Overclock não foi aberta; o boot standalone do sidecar usou HOME/dados em `/tmp` (`mkdtemp`), nunca `~/.overclock-app` nem `~/Library/Application Support/Overclock`; nenhum `git add/commit/stash/checkout/reset`; nenhuma instalação global (node embutido do app, v22.16.0). Os arquivos não commitados em `src/renderer/components/settings/cli-login-terminal.*` não foram tocados.

**Confirmado em RUNTIME** (não só strings):

- Sidecar 1.3.23 bootado standalone pela receita do §8 do dossiê 1.3.18 (`WS_TOKEN` + caps `OVERCLOCK_FILE_READ_*` + `OVERCLOCK_KEYSTORE_VIA_STDIN=1` com 32 bytes crus no stdin + pai persistente). Script preservado em `overclock-1323-extract/oc1323-boot.mjs`.
- **Mudança de protocolo vs 1.3.18:** o MCP HTTP agora é **stateful** — depois do `initialize`, toda chamada exige o header `Mcp-Session-Id` devolvido na resposta do initialize (sem ele, HTTP 400 "missing or invalid MCP session — re-envie o header Mcp-Session-Id"). Em 1.3.18 não havia sessão.
- **O endpoint importa:** `/mcp/claude` devolve **9 tools** (perfil worker); `/mcp/orchestrator` devolve **18 tools** (perfil connector). Em 1.3.18, todos os endpoints devolviam as mesmas 57.
- `tools/list` vivo com schemas completos gravado em [`overclock-1323-extract/sidecar-tools-runtime.json`](overclock-1323-extract/sidecar-tools-runtime.json) (as 18 do perfil connector).
- Sondas `tools/call` reais (script `oc1323-probe.mjs`): aliases ocultos funcionam (`pane_wait_idle`, `pane_spawn_many`, `overclock_squad_list`, `overclock_model_list`, `overclock_perf_events`, `overclock_task` respondem); gating de plano ativo; cron responde; memory quebrada.
- Descritor `sidecar.json` do boot: `armsVersion: 2`, `version: "0.8.0"`, `instance: "prod"`, `armsArgs`, `installRoot` — campos novos vs 1.3.18.

**Confirmado só por STRINGS do `index.jsc`** (4.592.448 bytes, sha256 `4aa0f6f8…8bf00`; loader `index.js` de 132 B **idêntico** ao da 1.3.18, hash `d1f949bf…`): env vars (84 `OVERCLOCK_*`, lista em `overclock-1323-extract/jsc-env-vars.txt`), nomes de tools antigos e novos coexistindo (camada de alias), textos de gating. Corpos de função seguem ilegíveis (bytecode bytenode).

**Diff de arquivos legíveis:** 86 arquivos comuns aos dois extracts → 77 idênticos, 9 alterados; 14 novos; 11 removidos (listas em `overclock-1323-extract/filelist-diff-vs-1318.txt` e `changed-vs-1318.txt`). Inventário completo com sha256 em `overclock-1323-extract/inventory-hashes-sha256.txt` (116 arquivos fora de `node_modules`/`_CodeSignature`; o bundle tem ~11.146 arquivos contando `sidecar/node_modules`).

**Não consultado / não confirmado:** ver §6.

---

## 2. Delta 1.3.18 → 1.3.23

O tema da 1.3.23 é **consolidação**: a superfície MCP encolheu de 57 para 18 tools (com aliases ocultos), as skills viraram uma suíte de papéis (OVKA-443), e o app ganhou degraus de plano (Boost/Pro/Ultra) enforced em runtime.

### 2.1 Superfície MCP (confirmado em runtime)

**18 tools vivas** (perfil connector, `/mcp/orchestrator`; 45 nomes da 1.3.18 saíram da listagem, 6 nomes novos entraram, 12 mantidos):

| Nova tool (6) | Funde/absorve (fonte: schema vivo + tabela old→new de `resources/arsenal/skills/oc-mcp/SKILL.md`) |
|---|---|
| `overclock_list {kind}` | `pane_list_providers`, `overclock_model_list`, `overclock_agent_list/get`, `overclock_skill_list`, `overclock_vault_list`, `overclock_media_providers` (+ `agents`/`skills` só no Ultra) |
| `overclock_media_generate {kind}` | `overclock_image/video/audio_generate` |
| `overclock_mission {op}` | `overclock_mission_list/get/create/set_status` |
| `pane_wait` | `pane_wait_idle`, `pane_wait_many` |
| `pane_attach` / `pane_detach` | **novidade real** — ver abaixo |
| `overclock_squad {op: list\|get\|run}` | `overclock_squad_list/get/spawn`; save/delete viraram tela (Cockpit) — existe mas gated por plano (não listada no connector standalone) |

Mantidas com schema alterado: `pane_spawn`, `pane_write` (+`writes[]`), `pane_read` (+`panes[]`, `includeTail`), `pane_close` (+`paneIds[]`), `pane_list`, `pane_whoami`, `handoff_submit`, `handoff_list`, `overclock_navigate` (+`url/missionId/workspacePath/create/open`, 25 targets), `overclock_status`, `app_observe`, `app_events` (+`source: app|perf` — **absorveu `overclock_perf_events`**; types enum: `pane.idle, pane.handoff, pane.error, pane.closed, dialog.opened, dialog.closed, skin.changed, mission.changed`).

**Aliases ocultos funcionam em runtime** (sonda real, não só doc): `pane_wait_idle`, `pane_spawn_many`, `overclock_squad_list`, `overclock_model_list`, `overclock_perf_events`, `overclock_task` todos respondem. Doc (`oc-mcp` §5): aliases aceitos "until 1.4.x". `overclock_workflow` e `overclock_catalog*` declarados **dormentes** ("install/search/organize/save live in the Cockpit"). Fonte: `overclock-1323-extract/resources/arsenal/skills/oc-mcp/SKILL.md` + sonda.

**`pane_attach`/`pane_detach` (a novidade de protocolo mais relevante):** espelha o PTY cru de um pane por **Unix socket** — `pane_attach({paneId})` → `{socket, token, cols, rows, framing}`; socket em `~/.overclock-app/panes/<paneId>.sock` modo 0600; framing 1 byte tipo + u32 big-endian length + payload; tipos `0x01` output, `0x02` input, `0x03` pane ended, `0x04` resize. Requer `attachable:true` no pane e `armsVersion >= 2` (o descritor do boot reportou `armsVersion: 2`). Doc: `oc-mcp` §"Live screen of a pane"; schema vivo no JSON.

**`pane_spawn` ganhou 5 campos e perdeu 1** (schema vivo):
- `expect {schema, retries=1}` — **contrato de entrega**: no `handoff_submit`, os `artifacts` do worker são validados contra o JSON Schema; mismatch devolve ao worker exatamente o que falta, até `retries` vezes; depois cai como `blocked`. **Substitui `overclock_task`.**
- `task` — **harness por tipo de tarefa** (Ultra): o app escolhe model/effort/skills/agent/CLI por uma matriz (`docs/workflows/harness-por-task.md`, interna deles) e **declara a escolha no receipt** ("harness B1 — sonnet-5 · medium · qa-fix-protocol"). Campo explícito vence a matriz; tipo desconhecido cai no default declarado, nunca recusa.
- `toolProfile` enum `worker|orchestrator|full` — quantas tools o pane **vê** no `tools/list` (exposição, não permissão: o gate continua no sidecar).
- `panes[]` (≤24) — N panes em UMA chamada (absorve `pane_spawn_many`).
- `workspacePath` — declara o workspace ao spawnar de fora (Arms/bot).
- removido: `chefe` ("agentic machinery dormant — use `task`").
- `agent` enum ganhou **`hermes`** e **`commandcode`** (14 valores; 1.3.18 tinha 12).

**`handoff_submit` — nova régua de tamanho do summary** (schema vivo): "1–2 sentences (≤280 chars)… >400 chars is auto-condensed (original → fullText); >1500 refused". Na 1.3.18 a regra era só "1–2 sentences" sem faixas nem recusa. A skill `oc-mcp` detalha: 400–1500 é condensado na primeira quebra de frase, sem turno extra.

**Perfis de exposição × modos × planos** (fonte: `oc-mcp` §4 + sonda): modo (`free|squad|agentic`, vem da missão e do teto do plano) × papel (`worker|orchestrator|connector|full`). Worker vê ≤9 tools; orchestrator +wait/close/mission/squad/clarify; connector (sessão MCP sem pane, o "robot") vê tudo + as 6 tools de app/screen. **Gating de plano confirmado em runtime:** `overclock_squad`, `overclock_squad_list`, `overclock_clarify` respondem *"not available on THIS ACCOUNT'S PLAN — it needs Pro (Squad), and the plan ceiling here caps every pane at free pane (Boost)… Do NOT retry and do NOT report it as a blocker."* — a recusa instrui o agente sobre como se comportar. Ladder: Boost (Livre, ≤15 tools) · Pro (Squad, +2) · Ultra (Agentic Harness, +3) · Robot (+6) · dev (+2: `app_diag`, `app_screenshot`).

**Cron saiu do dormitório (parcialmente):** em 1.3.18 `overclock_cron_*` eram fantasmas ("Cron backend is not wired"). Em 1.3.23, sonda real: `overclock_cron_list` → `{ok:true, count:0, jobs:[]}` — o backend está wired. Continua fora do `tools/list` (só por alias). Só testei list vazio; create não exercitado (§6).
**Memory continua morta:** `overclock_memory_read` → `{ok:false, "Cannot read properties of undefined"}`. `bridge_chat_history`, `overclock_logo`, `redline_pick_account` seguem sem registrar (não testados individualmente desta vez; sem Redline instalado — log de boot idêntico ao da 1.3.18).

### 2.2 Bundle e infra (fonte: inventário + hashes)

- **Os 5 `.mjs` top-level do sidecar SUMIRAM do bundle:** `handoff-stop.mjs`, `handoff-deliver.mjs`, `kimi-mcp-bridge.mjs`, `overclock-doctor.mjs`, `soft-status.mjs` não existem mais em `Resources/sidecar/`. O código-fonte legível dos hooks de handoff (a joia do extract 1.3.18) **não está mais disponível para clone**. Strings novas `OVERCLOCK_STOP_CHILD` / `OVERCLOCK_DELIVER_CHILD` sugerem que os hooks passaram a ser gerados/embutidos em runtime — não confirmado (§6).
- `index.jsc` cresceu 3,9 MB → 4,59 MB. `sidecar/package.json` **byte-idêntico** ao da 1.3.18. `MacOS/node` e `sidecar/bin/node` seguem v22.16.0 (hashes distintos entre si, mesmo tamanho).
- `Info.plist` novo: **`CFBundleDocumentTypes`** — o app se registra como editor Default de `.md`, `.txt`, `.json` (ícones `Document.icns/ico` novos em `Resources/`). O inventário 1.3.18 não citava document types — aparentemente novo.
- **arms-mcp (legível, diff real):** OVKA-283 — flag `--descriptor <caminho>` amarra o wrapper a UMA instalação; o sidecar publica `armsArgs` no descritor; `discovery` ganhou `instance?: 'prod'|'dev'|'beta'`. Motivo documentado no código: o comando publicado pelo Beta procurava `sidecar.json` e conectava na PRODUÇÃO com as duas abertas (origem do F-703). Arquivos: `overclock-1323-extract/arms-mcp/{bin.js,discovery.js,discovery.d.ts}` + teste novo `descriptorPin.ovka283.test.js`.
- `THIRD-PARTY-LICENSES.html`: entram binários de plataforma `@anthropic-ai/claude-agent-sdk-*` (7) e `@lydell/node-pty-*` (4), `rustls 0.22.4` no lado Rust, bump sentry 0.36→0.4x. Nenhuma remoção relevante.
- Env vars novas no jsc (baseline fraca — §6): família `OVERCLOCK_ADOPT_*` (adotar tmux local/host alias/filter), `OVERCLOCK_BOARD_MCP_URL/TOKEN` + `OVERCLOCK_DISABLE_BOARD_MCP` (board OverClick como MCP externo — boot log: "Board (overclick) não registrado… aponte OVERCLOCK_BOARD_MCP_URL"), `OVERCLOCK_PANE_TOOL_PROFILE`, `OVERCLOCK_PANE_LEAF`, `OVERCLOCK_INSTANCE`, `OVERCLOCK_HEADLESS`, `OVERCLOCK_REQUIRE_LICENSE_SIG`, `OVERCLOCK_LICENSE_CLAIM_JSON`, `OVERCLOCK_UNATTENDED_GATES`, `OVERCLOCK_WEB_DESKTOP_AUTH_EXCHANGE_PATH`, `OVERCLOCK_BOT_MODE`.

### 2.3 Squads, skills e prompts (fonte: clone + diff)

**OVKA-443 — consolidação das skills em uma suíte de papéis** (a maior mudança de conteúdo):

- **10 skills novas** em `resources/arsenal/skills/`: `oc-pilot` (orquestrador: plan/delegate/collect/synthesize), `oc-builder` (executor: uma tarefa, evidência fresca, commit com pathspec, handoff), `oc-scout` (pesquisador read-only, findings localizados path:line), `oc-conveyor` (reviewer adversarial, 1 issue por linha, contagem por severidade), `oc-route` (plano executável por estranho, failing-test-first), `oc-blackbox` (root cause antes de qualquer fix), `oc-stamp` (evidência antes de claim de done), `oc-showcase` (UI por regra, acessibilidade/touch primeiro), `oc-guide` (manual do produto para a pessoa), `oc-mcp` (manual do MCP para o agente, v2 — a fonte canônica da consolidação).
- **`oc-app-ui` DEPRECATED** — virou alias de redirecionamento para `oc-showcase` (a doutrina de product-UI foi absorvida); **`overclock-research-cite` → `oc-scout`** (cláusula de citação). As 6 skills `overclock-squad-*`/`overclock-skill-*` migraram de `squad-former/skills/` para `arsenal/skills/` (conteúdo idêntico). `squad-former` ficou só com agents + PLAYBOOK.
- **Instalação automática cross-CLI no boot** (`oc-mcp` §3): no boot do sidecar, as skills embarcadas são copiadas para o dir de skills de **cada** CLI (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.gemini/skills`, `~/.gemini/antigravity/skills`, `~/.kimi/skills`) — "a clean machine has them". "Brief a worker by role and it loads that role's skill first."
- Agentes atualizados para apontar a doutrina nova: `qa-swarm/agents/qa-swarm-reviewer.md` (base skill = `oc-conveyor`), `qa-vision/agents/qa-reviewer-estatico.md` (invocar `oc-conveyor` + `qa-finding-protocol`), `squad-former/agents/search-specialist.md` (`allowedSkills` troca `overclock-research-cite` → `oc-scout`). Os outros 77 arquivos de resources são **byte-idênticos** à 1.3.18 (incluindo todos os PLAYBOOKs de qa-swarm, qa-vision, absurd-landing, cinema-site, cinema e squad-former).

### 2.4 Hooks de handoff, UI, updater, segurança

- Hooks `.mjs` fora do bundle (2.2). O comportamento de handoff visível na 1.3.23 (via schemas + oc-mcp): attach/condense seguem no vocabulário (`handoff_submit.attach` existia na 1.3.18 e permanece); a régua de summary é a novidade documentada (2.1).
- UI: wizard dirigível por MCP (`overclock_navigate` targets `run-squad`, `run-agentic` com `goal`/`model`, `wizard-advance/set/fire/cancel`, `dialog-dismiss` com exceção "login/licence gate is NOT dismissible"), tabs por MCP, `view-files`/`view-sessions`. `overclock_navigate` absorveu skin (`target:"skin"`) e workspace (`workspace-open`/`workspace-add`/`workspace-create`).
- Segurança/licença: `OVERCLOCK_REQUIRE_LICENSE_SIG`, plan ceiling enforced no sidecar (2.1), socket de attach modo 0600 com token, skill docs explicitando "exposure, not permission — the sidecar gate and the handler stay the lock".
- Updater: sem delta visível nos legíveis (tauri-plugin-updater já constava na 1.3.18; não reinspecionei o binário Rust — §6).

---

## 3. Já existe no Nexus (verificado em código nesta rodada)

| Item 1.3.23 | Prova no Nexus |
|---|---|
| Lease registry / startKey (P0 da 1.3.18) | `src/main/pty/session-lease-registry.ts` (`issueLease`:56-80, `authorizeKill`:91-115 com recusas nomeadas); enforcement em `pty-manager.ts:2815-2823` e `:2905-2923` |
| Warm pool (P0 da 1.3.18) — **PARCIAL** | `src/main/pty/warm-pool.ts` completo (`take`:154, `evictStale`:121, reposição CPU-aware:95-116), **mas `spawnFn` nunca é registrado** e `take()` só é chamado em `src/main/orch/mission-fast-lane.ts:1019` — a maquinaria não está ligada ao spawn geral |
| Attach-mode do handoff (T3.1) | `src/main/orch/turn-end-handoff.ts:495-527` + `src/main/orch/handoff-attachments.ts:1-33` |
| Doutrina qa-swarm (T4) e contrato qa-vision (T5) | `src/main/orch/builtin-squads.ts:840-913` (qa-swarm, 1:1:N explícito em :851) e `:915-935` (qa-vision, F-XXX por bug em :921); playbooks em `resources/qa-swarm/`, `resources/qa-vision/`; `docs/QA-PROTOCOL.md` |
| allowedSkills `[]` = hard gate (T6) | `src/main/orch/gate.ts:252-259` (`isSkillAllowed`), `src/main/orch/skill-mirror.ts:572` (`allowed.size === 0 → []`); espelho cross-CLI em `skill-mirror.ts:186-195` e `agent-plugin-skill-mirror.ts` |
| Cron (que a 1.3.23 acabou de ligar) | Subsistema completo: `src/main/orch/cron-runtime.ts`, `cron-loop.ts`, `cron-execution-coordinator.ts`, tools `nexus_cron`/`nexus_cron_list`/`nexus_cron_cancel` (`tools-domain.ts:1755-1774`). **Nexus está à frente.** |
| app_events com cursor | `nexus_app_events` em `src/main/connectors/arms-endpoint.ts:145-171` (cursor `after` + `nextCursor`); perf: `nexus_perf_events` (`tools-domain.ts:1890-1903`, snapshot sem cursor) |
| Gating de tools por papel | `src/main/orch/mcp-protocol.ts:197-215` + `gate.ts:202-221` (`isToolAllowedForRole`) |
| Pipelines absurd-landing / cinema-site (T8) | `src/main/orch/builtin-squads.ts:963` e `:1025` |
| Hibernação de grid | `src/renderer/terminal/terminal-host.ts:1761-1776` (HIBERNATE_MIN_LIVE_HOSTS=24) |
| Wake de handoff para o orquestrador | `src/main/orch/idle-delivery.ts:377-422` (formato próprio, com trust labels) |

---

## 4. VALE PORTAR

| # | Pri | O que é (fonte no Overclock) | Por que importa para o Nexus | Alvo provável no Nexus | Esforço | Risco |
|---|---|---|---|---|---|---|
| 1 | **P0** | **Ligar o warm pool de verdade** — a 1.3.23 mantém `OVERCLOCK_WARM_POOL_SIZE` e o Nexus já tem `warm-pool.ts`, mas `spawnFn` não registrado e `take()` só no fast-lane (dívida do plano T2, confirmada em código) | Cold-start de worker continua cheio fora do fast-lane; a telemetria existe mas mede um pool que quase não serve spawn | `src/main/pty/pty-manager.ts` (registrar spawn/destroy) + `mission-fast-lane.ts:1019` | M | Médio (gate de autoridade no `take`) |
| 2 | **P0** | **`expect.schema` — contrato de entrega** (schema vivo de `pane_spawn.expect`; validação dos `artifacts` no `handoff_submit`, devolução nomeada do que falta, `retries=1`, depois blocked) | Hoje o Nexus aceita `artifacts` sem validar conteúdo (`tools-handoff.ts:173-235`); o orquestrador confia na palavra do worker. É o fecho do "evidence-mandatory" com mecanismo, não doutrina | `src/main/orch/tools-handoff.ts` (validação no submit) + caminho de spawn (propagar `expect`); schema zod em `src/shared/orch-types.ts` | M | Baixo |
| 3 | **P1** | **Régua de summary 280 / 400–1500 auto-condense na quebra de frase / >1500 recusado** (schema vivo de `handoff_submit.summary`) | O Nexus tem lanes inconsistentes: >280 vira verdade+ponteiro no hook, teto 32 KiB só na lane "plan", compactação silenciosa de 4000 nas outras (`tools-handoff.ts:266-288`). A faixa intermediária com condense automático (sem turno extra) melhora o que o orquestrador lê | `src/main/orch/tools-handoff.ts` + `turn-end-handoff.ts:319-330` | S | Baixo |
| 4 | **P1** | **Consolidação de tools em fused `op`/`kind` + aliases ocultos** (18 tools vivas vs 57; aliases até 1.4.x; validação per-op que recusa argumento fora do op nomeando os aceitos) | Redução de superfície cognitiva do modelo (a doc deles mede tokens por chamada). O Nexus tem dezenas de `nexus_*` sem camada de alias de renomeação (`mcp-protocol.ts:116-126` só canonicaliza namespace) | `src/main/orch/mcp-protocol.ts`, `tools-domain.ts` | M | Médio (quebra de clientes se mal sequenciado — exige alias primeiro) |
| 5 | **P1** | **Receipt que declara decisões** (harness escolhido no receipt do spawn — "harness B1 — sonnet-5 · medium · qa-fix-protocol"; capabilities gated declaradas no `overclock_status`) | O `task-router.ts:312-324` já tem `reason`/`policySource` no RouteDecision, mas a escolha não é surfacada de forma padronizada no receipt de spawn; agente não consegue ler "o que foi decidido por mim" | `src/main/orch/task-router.ts` + caminho de spawn de worker | S | Baixo |
| 6 | **P1** | **Suíte de skills de papel universais** (OVKA-443: pilot/builder/scout/conveyor/route/blackbox/stamp/showcase — texto puro em `overclock-1323-extract/resources/arsenal/skills/oc-*/SKILL.md`) + instalação automática no boot para o dir de skills de cada CLI | O Nexus já tem o vocabulário (`NEXUS_GUIDED_SKILL_ORDER` em `guided-squad-skills.ts`) e o espelho cross-CLI (`skill-mirror.ts:186-195`); faltam as skills de papel em si e o seed no boot para máquina limpa. Texto copiável, adaptando nomes de tools | novas skills em `resources/` + `src/main/orch/guided-squad-skills.ts` (entradas no array, regra §1.7 do plano) + seed no boot | M | Baixo |
| 7 | **P1** | **Harness-by-task unificado** (`pane_spawn {task:"corrigir bug"}` → model/effort/**skill**/agent/CLI numa matriz, tipo desconhecido → default declarado, nunca recusa) | O Nexus tem classificação tier+especialidade (`task-router.ts:46,102`) mas skill não entra na matriz e não há entrada única por task type no spawn | `src/main/orch/task-router.ts` + `guided-task-kind.ts` + spawn de worker | M | Médio |
| 8 | **P2** | **`pane_attach`/`pane_detach`** — espelho do PTY cru por Unix socket com token, framing binário (schema vivo + `oc-mcp` §"Live screen of a pane") | É o braço que falta para um bot externo **mostrar** um terminal ao vivo (hoje o Arms é metadata-only por decisão de segurança, `app-events.ts:5-6`). Adotar exige decidir se bytes de terminal (com segredos potenciais) podem sair do main — socket 0600 + token + `attachable` opt-in é o modelo deles | módulo novo em `src/main/pty/` + gate em `src/main/connectors/arms-endpoint.ts` | M | **Alto** (expõe bytes do PTY; conflita com a política metadata-only do Arms — decisão de segurança prévia) |
| 9 | **P2** | **OVKA-283 — descriptor pinning do conector** (`--descriptor <caminho>` publicado pelo próprio sidecar em `armsArgs`; `instance: prod|dev|beta` no descritor) | Mesmo bug latente no Nexus: `bin/nexus-arms.mjs` procurando o descritor default pode conectar na instância errada com duas abertas (prod + dev) | `bin/nexus-arms.mjs` + quem grava o descritor do Arms | S | Baixo |
| 10 | **P2** | **Wizard de missão dirigível por MCP** (`overclock_navigate` targets `run-squad`/`run-agentic`/`wizard-*`/`dialog-dismiss`, com resolução id→título→contém e candidatos em ambiguidade) | Permite ao agente/bot operar a UI sem print nem clique; o Nexus tem `nexus_navigate`? — não há equivalente de wizard automatizável (verificado: não existe target wizard no Nexus) | tools de navegação em `src/main/orch/tools-domain.ts` + renderer | M | Médio |
| 11 | **P2** | **MCP HTTP stateful com `Mcp-Session-Id`** (erro 400 didático; hint aponta stdio) | Se/quando o MCP HTTP do Nexus expor sessões, alinhar ao spec Streamable HTTP evita o suporte "400 misterioso". Hoje o endpoint Arms do Nexus é próprio, não MCP genérico | `src/main/connectors/arms-endpoint.ts` / futuro MCP HTTP | S | Baixo |
| 12 | **P2** | **Recusa de plano que instrui o agente** ("Do NOT retry and do NOT report it as a blocker… deliver with what you have and say what you skipped") | Independente de existir plano: é o padrão de **recusa comportamental** — toda recusa de tool deveria dizer ao agente o que fazer em seguida. Aplicável ao gate de papel do Nexus hoje | `src/main/orch/gate.ts` (mensagens de `isToolAllowedForRole`) | S | Baixo |

---

## 5. NÃO vale portar

| Item | Motivo |
|---|---|
| Cron do Overclock | O Nexus já tem subsistema completo e maduro (`cron-runtime.ts` + 3 tools); o deles acabou de sair do dormitório (só `list` vazio confirmado) |
| OverMemory / `overclock_memory_*` | Dormente até no original: `overclock_memory_read` responde `{ok:false}` em runtime na 1.3.23; é marketing do site, não feature viva |
| Plan gating Boost/Pro/Ultra em si | Modelo de negócio deles; o Nexus tem `free|pro|team` sem ceiling de feature (`billing-ipc.ts:67`) e não há demanda registrada. (A **mensagem** de recusa comportamental vale — item 12 acima) |
| Tools fantasmas restantes (`bridge_chat_history`, `overclock_logo`, `redline_pick_account`) | Seguem sem registrar em runtime; portar seria inventar feature |
| `app_diag` / `app_screenshot` (dev-only) | O Nexus já tem diagnóstico próprio (`app_observe` equivalente existe? — o Nexus tem `nexus_perf_events` e diagnósticos internos; não há dor registrada) |
| overdrive / panes mirrorless | Decisão T9 do plano 1.3.18 mantida: hibernação (68a2f355) cobre a dor; bypassar canais de autoridade conflita com o modelo de segurança do Nexus |
| `CFBundleDocumentTypes` (registrar como editor de .md/.txt/.json) | Cosmético; o Nexus não é editor de texto genérico |
| Skills `oc-guide` (manual do produto) e `oc-app-ui` (deprecated) | A primeira é documentação do produto deles; a segunda é alias morto |
| Suporte a CLIs `hermes` e `commandcode` | Sem demanda registrada; adapters do Nexus (`src/adapters/builtin/`, 16 CLIs) não os incluem e ninguém pediu |

---

## 6. Perguntas abertas / não confirmado

1. **Hooks de handoff fora do bundle** — para onde foram `handoff-stop.mjs`/`handoff-deliver.mjs`? Strings `OVERCLOCK_STOP_CHILD`/`OVERCLOCK_DELIVER_CHILD` sugerem geração em runtime pelo sidecar, mas não provei. Consequência prática: o delta 1.3.18→1.3.23 do mecanismo de handoff (F-xxx novos) **não pôde ser lido** — só o que vazou em schemas e na skill `oc-mcp`.
2. **`expect.schema` não exercitado** — li o schema vivo e a doc; não fiz um spawn real com contrato (HOME scratch sem CLI configurado). Enforcement descrito pela doc, não observado.
3. **`overclock_squad {op:run}`** — gated por plano no standalone (Boost); comportamento dentro de uma missão squad real não observado.
4. **Cron**: só `overclock_cron_list` vazio confirmado; `cron_create` não exercitado.
5. **`pane_attach`**: schema e protocolo lidos na doc; não abri socket de attach (exigiria um pane vivo, que exige CLI configurado).
6. **Release notes 1.3.19 → 1.3.23 não localizadas**: o site público ([overclock.sh/en](https://overclock.sh/en)) não publica changelog por versão (marketing confirma a ladder Boost $19/Pro $39/Ultra $79, Harness Ultra, Jarvis, Redline e "Overclock Shot" como perks Ultra); o bundle não embute changelog legível (só a string "novidades"). Não consultei Discord/comunidade (fechado).
7. **Diff de env vars é fraco**: a baseline são as 13 vars citadas nos docs 1.3.18 (o jsc da 1.3.18 não foi preservado). As "novas" de §2.2 podem incluir vars que já existiam.
8. **Binário Rust (`MacOS/overclock`) não reinspecionado** (strings/otool): mudanças no overdrive/updater entre 1.3.18 e 1.3.23 não foram medidas nesta rodada.
9. **Overclock Shot** — **não analisado**: só existe `~/Downloads/Overclock.Shot-1.3.0-arm64.dmg`; por regra da missão, o DMG não foi montado.
10. **`OVERCLOCK_ADOPT_*` (adotar tmux local)** — só visto em strings; sem doc nem runtime. Potencial feature nova de adoção de sessões, não confirmada.

---

### Apêndice — artefatos gerados nesta rodada

| Arquivo | Conteúdo |
|---|---|
| `docs/analysis/overclock-1323-extract/sidecar-tools-runtime.json` | **Versionável** — as 18 tools vivas com schemas completos (boot standalone, `/mcp/orchestrator`) |
| `docs/analysis/overclock-1323-extract/` (resto, gitignored) | 106 clones legíveis (resources, arms-mcp, plist, package.json, loader) + evidência: `inventory-hashes-sha256.txt`, `inventory-files.txt`, `filelist-diff-vs-1318.txt`, `changed-vs-1318.txt`, `jsc-env-vars.txt`, `oc1323-boot.mjs`, `oc1323-probe.mjs` |
| `docs/analysis/overclock-1323-delta-inventario.md` | este documento |
