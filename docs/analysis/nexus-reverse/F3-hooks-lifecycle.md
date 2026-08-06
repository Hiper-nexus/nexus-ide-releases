# F3 — Hooks & lifecycle

> Engenharia reversa do NexusIDE — frente F3. Data: 2026-08-06. Base: HEAD `254ddab4` + working tree.
> Regra desta frente: toda afirmação cita `caminho/arquivo.ts:linha`. Onde não verifiquei, há `lacuna:`.

---

## 0. Resumo (10 linhas)

1. O Nexus não tem *um* sistema de hooks: tem **três canais independentes**, com transportes, autenticações, servidores HTTP e semânticas diferentes. Confundi-los é o erro nº 1 ao ler este código.
2. **Canal A — “managed agent hooks”** (`src/main/agent-hooks/`): edita o perfil **REAL e GLOBAL** do usuário (`~/.claude/settings.json`, `~/.codex/hooks.json`), sob consentimento explícito. Só reporta atividade. Nunca bloqueia.
3. **Canal B — “status hooks”** (emdash wave 1, `src/main/orch/hook-status-config.ts` + `src/vendor/emdash/hooks/`): escrito **por spawn e por sessão**, nunca no perfil real. Alimenta o reducer de status semântico. Nunca bloqueia (`|| true` por construção).
4. **Canal C — “skill-gate”** (`src/main/orch/hooks-gen.ts`): o único canal com poder de **veto**. Só existe dentro do `$HOME` efêmero.
5. Dos 3 eventos do Canal C, **apenas `pretool` bloqueia** (`hooks-gen.ts:91-110`, `process.exit(2)`). `posttool` é no-op server-side (`mcp-server.ts:451-453`) e `stop` virou fail-open desacoplado no commit `5ac0fd58` (2026-08-06).
6. Cada canal fala com um servidor HTTP **diferente**: Canal A tem servidor próprio (`hook-http-server.ts:98`), Canais B e C compartilham o servidor MCP embutido (`mcp-server.ts:1147`).
7. `.agents/hooks.json`, `.codex/hooks.json` e `.grok/hooks/` **na raiz do repositório NÃO são do Nexus** — são artefatos do **Overclock**, gitignorados e nunca lidos nem escritos pelo código do Nexus (§3.1).
8. Ordem de execução entre canais **não é orquestrada pelo Nexus**: quem serializa é a CLI hospedeira, por evento. O Nexus só garante *idempotência* e *separação por marcador* (`NEXUS_HOOK_STATUS`).
9. Invariante transversal (§12.4 do código): hook **nunca** autoriza evidência nem conclusão de missão. Está hard-coded como literal `false` em três lugares independentes.
10. A auditoria [`2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md) está **desatualizada em um ponto central** — ver §3.4.

---

## 1. Trace ponta-a-ponta

### 1.A — Canal A: do boot ao `PaneSessionState` (hook de atividade)

| # | Passo | Onde |
|---|---|---|
| 1 | Electron pronto; IPC de ingest registrado antes de qualquer pane existir. | `src/main/main.ts:753` → `registerAgentHookIpc()` |
| 2 | Registra os installers Claude+Codex **sem instalar** (`enabled:false`) — instalar edita config global do usuário. | `src/main/main.ts:806` → `src/main/agent-hooks/register-default-installers.ts:32-39` |
| 3 | Sobe o servidor HTTP de ingest **em loopback**, porta efêmera, token hex de 24 bytes. | `src/main/agent-hooks/hook-http-server.ts:81`, `:98` (`server.listen(0,'127.0.0.1')`) |
| 4 | Grava o *endpoint file* `<userData>/agent-hooks/endpoint.env` com `mode 0o600`, contendo `export NEXUS_AGENT_HOOK_PORT` + `NEXUS_AGENT_HOOK_TOKEN`. | `hook-http-server.ts:82`, `:63-68` |
| 5 | Main memoriza o caminho para o PTY injetar depois. | `src/main/main.ts:808` → `configureAgentHookEndpointPath(...)` |
| 6 | Consentimento: lê decisão persistida; se `undecided`, abre diálogo nativo (“Ativar os hooks de status do NexusIDE?”). | `src/main/agent-hooks/hook-consent.ts:62-71`; diálogo em `src/main/main.ts:811-823` |
| 7 | Aplica a decisão **de forma idempotente a cada launch**: `granted` → instala; qualquer outra → remove hooks que um build anterior tenha auto-instalado. | `src/main/main.ts:828-829` |
| 8 | Instalação Claude: escreve o script gerenciado em `~/.nexus/agent-hooks/claude-hook.sh` (`0755`, write atômico via tmp+rename) e injeta o comando em `~/.claude/settings.json`. | `src/main/agent-hooks/claude-hook-service.ts:184-195`; caminho em `installer-utils.ts:81-86`; write em `installer-utils.ts:123-150` |
| 9 | O comando injetado é defensivo por construção: `if [ -x '<script>' ]; then /bin/sh '<script>'; fi` — script ausente vira no-op, não erro da CLI. | `installer-utils.ts:88-91` |
| 10 | Antes de sobrescrever a config do usuário, faz backup `<config>.bak` preservando o modo restritivo do original. | `installer-utils.ts:186-217` |
| 11 | Codex: mesma mecânica em `~/.codex/hooks.json`, **mais** o seed de *trust state* em `~/.codex/config.toml` (Codex ≥ 0.129 exige revisão interativa de hooks não confiados). | `src/main/agent-hooks/codex-hook-service.ts:229-241`, `:184-211`; formato da chave em `codex-hook-trust.ts:82-85` |
| 12 | Pane nasce: o PTY injeta `NEXUS_AGENT_HOOK_ENDPOINT` (o caminho do arquivo) e `NEXUS_PANE_KEY = sessionId` no env do processo da CLI. | `src/main/pty/pty-manager.ts:1233-1238` |
| 13 | A CLI dispara um evento (ex.: `PreToolUse`). O script faz `.` (source) do endpoint file para obter porta+token — **o segredo nunca vive no arquivo de config**. | `claude-hook-service.ts:75-77` |
| 14 | Guard: sem porta, sem token ou sem `NEXUS_PANE_KEY`, sai `0` silenciosamente. | `claude-hook-service.ts:78-80` |
| 15 | `POST http://127.0.0.1:$PORT/hook/claude`, form-urlencoded, header `X-Nexus-Agent-Hook-Token`, timeouts curtos (`--connect-timeout 0.5 --max-time 1.5`), `|| true`, e **`exit 0` incondicional**. | `claude-hook-service.ts:85-91` |
| 16 | Servidor: só `POST`; rota casa `^/hook/([a-z0-9-]+)$`; token comparado em tempo constante. | `hook-http-server.ts:135`, `:141`, `:147-154` (+ `tokenMatches` em `:11-16`) |
| 17 | Corpo lido com teto de 1 MB. | `hook-http-server.ts:156` + `HOOK_REQUEST_MAX_BYTES` em `src/shared/agent-hook-listener.ts:45` |
| 18 | `sessionId` sai de `paneKey` (ou `sessionId`); body form-encoded → parse → normalização. | `hook-http-server.ts:178-179` → `hook-ingest.ts:113-135` |
| 19 | Publica atividade no bridge do agent-runtime e notifica os *taps* (ex.: desktop pet). | `hook-ingest.ts:78-82` |
| 20 | Se o payload traz `providerSession`, persiste o id de resume do provider para aquele pane. | `hook-ingest.ts:83-99` |
| 21 | Mapeamento final: `working|blocked|waiting → busy`, `done → idle`. `blocked`/`waiting` **continuam `busy`** de propósito, para a UI não parecer ociosa. | `src/main/agent-hooks/agent-hook-activity-mapper.ts:28-49` |
| 22 | A resposta HTTP **recusa explicitamente** autorizar evidência/conclusão: `authorizesEvidence:false`, `authorizesMissionCompletion:false` como literais. | `hook-http-server.ts:183-191`; espelhado em `agent-hook-activity-mapper.ts:50-55` |

**Gêmeo IPC do mesmo caminho:** o renderer pode reportar status pelo canal `AGENT_HOOK_CHANNELS.ingestStatus`, mas só para uma sessão que ele **prove possuir** — `getOwnedAgentSessionInfo(event.sender, sessionId)`, fail-closed (`src/main/agent-hooks/hook-ipc.ts:32-34`). Sem isso, um renderer comprometido envenenaria o estado e o resume-id de qualquer pane.

### 1.B — Canal B: status semântico por sessão (nunca bloqueia)

| # | Passo | Onde |
|---|---|---|
| 1 | No spawn orquestrado, o env do pane recebe `NEXUS_GATE_TOKEN` (bearer por pane) e `NEXUS_HOOK_URL`. | `src/main/orch/mcp-server.ts:707-716` (`NEXUS_HOOK_URL: hookStatusUrl()`, `:714`) |
| 2 | `hookStatusUrl()` = `http://127.0.0.1:<porta>/hook/status` — **o mesmo servidor** do MCP e do gate. | `mcp-server.ts:198` |
| 3 | Os comandos de hook são gerados a partir de tabelas de spec por CLI (`hookKey → command`). | `src/vendor/emdash/hooks/flavors.ts:73-83` (claude), `:128-143` (codex), `:148-161` (kimi), `:214-227` (grok) |
| 4 | O comando POSIX carrega o marcador `NEXUS_HOOK_STATUS=1`, referencia **só variáveis de env** (nenhum segredo em disco) e termina em `\|\| true`. | `src/vendor/emdash/hooks/hook-commands.ts:47-64`; marcador em `:31` |
| 5 | **Onde cada CLI recebe** (divergência deliberada por família — ver §2.B). Claude-family: dentro do settings da sessão. | `src/main/orch/hooks-gen.ts:296` (HOME efêmero) e `:248` (arquivo `--settings` para HOME real) |
| 6 | Codex: overrides `-c hooks.<Evento>=[...]` no argv — **zero escrita em disco**, idempotente por construção. | `src/main/orch/hook-status-config.ts:80-87`; aplicado em `mcp-server.ts:859` |
| 7 | Kimi: array plano `hooks = [{event, command}]` mesclado no `config.toml` do overlay privado. | `hook-status-config.ts:95-107`; aplicado em `src/main/orch/cli-mcp-session-kimi.ts:111` |
| 8 | Grok: documento próprio `hooks/nexus.json` dentro do overlay `GROK_HOME`; hooks do usuário entram por symlink e são excluídos do sync-back. | `hook-status-config.ts:119-125`; aplicado em `src/main/orch/cli-mcp-session-grok.ts:219-222`; exclusão em `:235` |
| 9 | A CLI dispara; `curl` posta o JSON bruto com `authorization: Bearer $NEXUS_GATE_TOKEN` e os headers `X-Nexus-Hook-Event` / `X-Nexus-Hook-Flavor`. | `hook-commands.ts:55-62` |
| 10 | Roteamento no servidor embutido: `/hook/status` + `POST`. Sem bearer válido → 401 antes de chegar aqui. | `mcp-server.ts:1165-1168`; bearer em `mcp-server.ts:1150-1154` |
| 11 | Corpo capado em 16 KB; excesso responde 400 e **fecha a conexão depois do flush** (destruir antes racearia). | `src/main/orch/hook-status-endpoint.ts:28`, `:228-241` |
| 12 | Envelope validado por zod `.strict()`: `eventType` (1..64), `flavor` (enum), `body` (record). | `hook-status-endpoint.ts:39-45` |
| 13 | Parse por flavor → `CanonicalHookEvent` (`status` \| `session` \| `ignore`). | `hook-status-endpoint.ts:116` → `src/vendor/emdash/hooks/flavors.ts:236-252`; tipo em `src/vendor/emdash/hooks/hooks-types.ts:38-53` |
| 14 | Sem `sessionId` ligado ao bearer (race de spawn, pane já morto) → **200 com `applied:false`**, não erro. | `hook-status-endpoint.ts:126-138` |
| 15 | Reducer semântico aplica o evento. | `hook-status-endpoint.ts:141-147` → `src/main/orch/agent-status.ts:420` |
| 16 | Reducer estourou → **500 isolado**: o canal de hook nunca derruba o gate que vive no mesmo servidor. | `hook-status-endpoint.ts:159-166` |
| 17 | Resposta carrega `authorizesEvidence:false` — terceira afirmação independente do invariante §12.4. | `hook-status-endpoint.ts:148-157` |

### 1.C — Canal C: skill-gate, do `PreToolUse` ao veto

| # | Passo | Onde |
|---|---|---|
| 1 | Política decide se o worker ganha `$HOME` efêmero — **único lugar onde o gate client é escrito**. | `src/main/orch/spawn-home-policy.ts:37-59` |
| 2 | `prepareEphemeralHome` cria `~/.nexus/ephemeral/<token12>` com `mode 0o700` (o dir guarda o bearer do MCP). | `src/main/orch/hooks-gen.ts:270-281` |
| 3 | Escreve `nexus-gate.mjs` (conteúdo = `HOOK_SCRIPT`) com `mode 0o700`. | `hooks-gen.ts:283-284`; script em `hooks-gen.ts:19-113` |
| 4 | Registra as 3 entradas de gate no `settings.json` do HOME efêmero: `PreToolUse` (matcher `*`), `PostToolUse` (matcher `*`), `Stop` (sem matcher). `mergeClaudeStatusHooks` só **acrescenta** os status hooks do Canal B, sem tocar nessas entradas. | `hooks-gen.ts:296-320`; arquivo escrito em `:322-326` |
| 5 | Env do pane recebe `NEXUS_GATE_URL` + `NEXUS_GATE_TOKEN`. | `mcp-server.ts:711-712` |
| 6 | **`pretool`** — a CLI vai chamar uma tool; o script lê stdin e faz `POST $NEXUS_GATE_URL/pretool` **síncrono**. | `hooks-gen.ts:91-97` (branch), `:40-55` (`post`) |
| 7 | Servidor avalia: tool `Skill` → allowlist de skills; qualquer outra → allowlist de tools + perfil de reviewer + autoridade read-only. | `mcp-server.ts:402-449` |
| 8 | Veredito `allow:false` → o script imprime a razão em stderr e **`process.exit(2)`**, que é como o Claude Code cancela a tool call. | `hooks-gen.ts:102-105` |
| 9 | **Fail-closed total no `pretool`**: sem credencial (`:92-95`), stdin não-JSON (`:98-101`), gate inalcançável (`:106-109`) — todos `exit 2`. | `hooks-gen.ts:92-109` |
| 10 | **`posttool`** — o servidor responde `allow:true` incondicionalmente. É um no-op observável. | `mcp-server.ts:451-453` |
| 11 | **`stop`** — o script **não espera resposta**: grava o payload em `os.tmpdir()/nexus-hook-<pid>.json`, relança a si mesmo `detached` com `NEXUS_HOOK_CHILD=1` e sai `0` em milissegundos. | `hooks-gen.ts:69-90` |
| 12 | O neto faz a rede, apaga o tmp e sai `0` — falha em silêncio por design. | `hooks-gen.ts:58-64` |
| 13 | O servidor, mesmo assim, revalida no store se existe handoff confiável daquela sessão+encarnação; erro de leitura **bloqueia** (não fabrica aceitação). | `mcp-server.ts:454-471` |
| 14 | `evaluateStop` computa o veredito: worker sem handoff recebe `allow:false` com instrução de chamar `nexus_handoff_submit`; escape após 3 tentativas para nunca prender o agente. | `src/main/orch/gate.ts:619-639`; `MAX_STOP_ATTEMPTS = 3` em `gate.ts:70` |
| 15 | **Esse veredito hoje é descartado pelo cliente** — ver §3.4. O backstop real é `src/main/orch/worker-handoff-enforcement.ts`, que observa status semântico + exit do PTY e não depende de hook nenhum. | `hooks-gen.ts:33` (o próprio código declara: “worker-handoff-enforcement segue como backstop”) |

---

## 2. Inventário

### 2.A — Componentes

| Componente | Arquivo:linha | Responsabilidade |
|---|---|---|
| `AGENT_HOOK_TARGETS` | `src/shared/agent-hook-types.ts:10-25` | 14 alvos declarados (claude, codex, gemini, cursor, amp, droid, grok, copilot, kimi…). **Só 2 têm installer.** |
| `ORCA_HOOK_PROTOCOL_VERSION` | `src/shared/agent-hook-types.ts:48` | `'1'`. Divergência gera warn-once diagnosticável, não falha. |
| Registro de installers | `src/main/agent-hooks/register-default-installers.ts:26-27` | Registra **apenas** `claude` e `codex`. |
| Registry de services | `src/main/agent-hooks/managed-agent-hook-controls.ts:32-37` | Map imutável (`new Map(...).set(...)`), sem mutação in-place. |
| Installer Claude | `src/main/agent-hooks/claude-hook-service.ts:130-214` | Escreve `~/.claude/settings.json` + `~/.nexus/agent-hooks/claude-hook.sh`. |
| Installer Codex | `src/main/agent-hooks/codex-hook-service.ts:131-268` | Escreve `~/.codex/hooks.json` + seed de trust em `~/.codex/config.toml`. |
| Trust do Codex | `src/main/agent-hooks/codex-hook-trust.ts:82-85` | Chave = `<realpath(hooks.json)>:<event_snake_case>:<groupIndex>:<handlerIndex>`. |
| Utilitários de install | `src/main/agent-hooks/installer-utils.ts:41-217` | Write atômico, backup `.bak`, matcher de comando gerenciado, wrapper POSIX. |
| Servidor HTTP (Canal A) | `src/main/agent-hooks/hook-http-server.ts:75-128` | Loopback, porta efêmera, token hex, endpoint file `0o600`. |
| Ingest (Canal A) | `src/main/agent-hooks/hook-ingest.ts:61-135` | Normaliza payload, publica atividade, persiste provider session. |
| Mapper de atividade | `src/main/agent-hooks/agent-hook-activity-mapper.ts:28-56` | `AgentStatusState → PaneSessionState`, congelado, activity-only. |
| Consentimento | `src/main/agent-hooks/hook-consent.ts:19-71` | Decisão persistida em `<userData>/agent-hooks/consent.json`. |
| IPC de ingest | `src/main/agent-hooks/hook-ipc.ts:18-38` | Mesmo ingest, autorizado por posse da sessão. |
| Specs por flavor (Canal B) | `src/vendor/emdash/hooks/flavors.ts:73-227` | Tabelas `hookKey → command` para claude/codex/kimi/grok. |
| Builders de comando (Canal B) | `src/vendor/emdash/hooks/hook-commands.ts:47-135` | curl POSIX `\|\| true` / PowerShell `SilentlyContinue` + base64. |
| Wiring por CLI (Canal B) | `src/main/orch/hook-status-config.ts:48-125` | Merge/geração por família, marker-aware e idempotente. |
| Endpoint `/hook/status` | `src/main/orch/hook-status-endpoint.ts:100-263` | zod → parse por flavor → reducer, fail-closed isolado. |
| `HOOK_SCRIPT` (Canal C) | `src/main/orch/hooks-gen.ts:19-113` | Cliente do skill-gate. Forma **divergente por evento**, deliberadamente. |
| `prepareEphemeralHome` | `src/main/orch/hooks-gen.ts:265-403` | `$HOME` descartável: gate hooks, trust de pasta, identidade de auth, anti-marketplace. |
| Política de HOME | `src/main/orch/spawn-home-policy.ts:37-59` | Decide quem recebe HOME efêmero — e portanto quem recebe o gate client. |
| Gate server | `src/main/orch/mcp-server.ts:385-479` | `pretool` / `posttool` / `stop`. |
| `evaluateStop` | `src/main/orch/gate.ts:619-639` | Política do stop; escape em 3 tentativas. |

### 2.B — Tabela de eventos (o entregável central)

**Canal A — managed agent hooks (perfil REAL do usuário, sob consentimento)**

| Evento | Matcher | Bloqueante? | Dispatcher (arquivo:linha) |
|---|---|---|---|
| `UserPromptSubmit` | — | silencioso | `claude-hook-service.ts:28` → script `:85-91` (`exit 0`) |
| `Stop` | — | silencioso | `claude-hook-service.ts:29` |
| `StopFailure` | — | silencioso | `claude-hook-service.ts:30` |
| `PreToolUse` | `*` | silencioso | `claude-hook-service.ts:31` |
| `PostToolUse` | `*` | silencioso | `claude-hook-service.ts:32` |
| `PostToolUseFailure` | `*` | silencioso | `claude-hook-service.ts:33` |
| `PermissionRequest` | `*` | silencioso | `claude-hook-service.ts:34` |
| `SessionStart` (codex) | — | silencioso | `codex-hook-service.ts:34` → script `:91-97` |
| `UserPromptSubmit` (codex) | — | silencioso | `codex-hook-service.ts:35` |
| `PreToolUse` (codex) | — | silencioso | `codex-hook-service.ts:36` |
| `PermissionRequest` (codex) | — | silencioso | `codex-hook-service.ts:37` |
| `PostToolUse` (codex) | — | silencioso | `codex-hook-service.ts:38` |
| `Stop` (codex) | — | silencioso | `codex-hook-service.ts:39` |

> Nenhum evento do Canal A pode bloquear: o corpo do script termina em `exit 0` incondicional (`claude-hook-service.ts:91`, `codex-hook-service.ts:97`) e o curl leva `|| true`. Timeout declarado na config: 10 s (`installer-utils.ts:39`), mas o curl se auto-limita em 1,5 s (`claude-hook-service.ts:86`).

**Canal B — status hooks por sessão (emdash wave 1)**

| CLI | Eventos (`hookKey`) | Bloqueante? | Spec (arquivo:linha) | Onde é escrito |
|---|---|---|---|---|
| Claude / GLM / LongCat | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop` | silencioso | `flavors.ts:73-83` | `hooks-gen.ts:296` (HOME efêmero) / `hooks-gen.ts:248` (flag `--settings`) |
| Codex | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PermissionRequest` | silencioso | `flavors.ts:128-143` | argv `-c` — `mcp-server.ts:859` |
| Kimi | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SessionEnd` | silencioso | `flavors.ts:148-161` | `cli-mcp-session-kimi.ts:111` |
| Grok | idem Kimi (9 eventos) | silencioso | `flavors.ts:214-227` | `cli-mcp-session-grok.ts:219-222` |

> Sem matcher em nenhum: as specs carregam só `hookKey` + `command` (`flavors.ts:36-40`). Silêncio garantido por `|| true` (`hook-commands.ts:62`) e `SilentlyContinue` no Windows (`hook-commands.ts:76`).
> `UserPromptSubmit` no Codex é **extensão do Nexus** — o emdash upstream não a tinha, e sem ela um pane Codex nunca reportaria `working` (`flavors.ts:132`).

**Canal C — skill-gate (o único com veto)**

| Evento | Matcher | Bloqueante? | Forma | Dispatcher (arquivo:linha) |
|---|---|---|---|---|
| `PreToolUse` → `pretool` | `*` | **BLOQUEANTE (fail-closed)** | síncrono; `exit 2` em toda falha | cliente `hooks-gen.ts:91-110`; servidor `mcp-server.ts:402-449` |
| `PostToolUse` → `posttool` | `*` | silencioso (no-op) | síncrono, mas resposta é sempre `allow:true` | cliente `hooks-gen.ts:305-312`; servidor `mcp-server.ts:451-453` |
| `Stop` → `stop` | — | **silencioso (fail-open) desde `5ac0fd58`** | desacoplado: grava tmp, relança `detached`, `exit 0` | cliente `hooks-gen.ts:69-90`; servidor `mcp-server.ts:454-475` + `gate.ts:619-639` |

---

## 3. Não-óbvio / armadilhas

### 3.1 — `.agents/hooks.json`, `.codex/hooks.json` e `.grok/hooks/` na raiz **não são do Nexus**

Este é o achado mais importante da frente, porque o próprio briefing os lista como se fossem artefatos do produto.

Os três arquivos existem na raiz deste repositório e **todos apontam para o Overclock**:

- `.agents/hooks.json` → `"/Applications/Overclock.app/Contents/Resources/sidecar/bin/node" "~/.overclock-app/handoff-deliver.mjs"`, evento `Stop`.
- `.codex/hooks.json` → `node "~/.overclock-app/soft-status.mjs"` em `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PermissionRequest`/`Stop`, mais um segundo grupo `Stop` com `handoff-deliver.mjs`.
- `.grok/hooks/overclock-soft-status.json` → `soft-status.mjs` em 6 eventos.

Provas de que não pertencem ao Nexus:

1. Estão **gitignorados e não rastreados**: `.gitignore:148` (`/.agents/`), `.gitignore:98` (`.codex/`), `.gitignore:96` (`.grok/`); `git ls-files .agents .codex .grok` retorna vazio.
2. **Nenhum código do Nexus escreve nesses caminhos de projeto.** O installer do Codex escreve em `join(home, '.codex', 'hooks.json')` — HOME, não cwd (`codex-hook-service.ts:46-48`). O do Claude, em `join(home, '.claude', 'settings.json')` (`claude-hook-service.ts:42-44`). O documento Grok do Nexus chama-se `nexus.json` e vive no overlay `GROK_HOME`, não em `<projeto>/.grok/hooks/` (`hook-status-config.ts:112`, `cli-mcp-session-grok.ts:210-222`).
3. O nome do arquivo Grok (`overclock-soft-status.json`) e o marcador do Nexus (`NEXUS_HOOK_STATUS`, `hook-commands.ts:31`) são disjuntos.

**Consequência prática:** nesta máquina, um pane Codex rodando com `cwd` = raiz do repo dispara hooks do Overclock **e** os do Nexus no mesmo evento. Não é conflito de design do Nexus; é contaminação de ambiente de dev. Ver `lacuna:` em §5 sobre precedência real.

### 3.2 — Ordem e precedência: o Nexus não orquestra, ele co-existe

Não existe, em lugar nenhum do código, um scheduler que ordene hooks entre canais. O que existe:

- **Dentro de um mesmo arquivo de config**, quem serializa é a CLI hospedeira. O Nexus só controla a *posição*: `applyManagedHooks` sempre **anexa** a entrada gerenciada depois de limpar a anterior — `[...cleaned, definition]` (`claude-hook-service.ts:103-108`, `codex-hook-service.ts:107-108`). Ou seja, hook gerenciado do Nexus roda **por último** entre os do mesmo evento naquele arquivo.
- **Entre Canal B e Canal C no mesmo `settings.json`**: `mergeClaudeStatusHooks` recebe o mapa que já contém as entradas de gate e só acrescenta as suas (`hooks-gen.ts:296-320`). As entradas de gate ficam **antes** das de status no array de `PreToolUse`.
- **Idempotência por marcador**, não por posição: `filterUserHooks` remove qualquer entrada cuja serialização contenha `NEXUS_HOOK_STATUS` antes de reescrever (`hook-commands.ts:34-37`); `createManagedCommandMatcher` reconhece o hook do Canal A pelo *substring do caminho* `agent-hooks/<script>` (`installer-utils.ts:64-78`).
- **Precedência entre escopos (home vs projeto)** é decisão da CLI, não do Nexus — o Nexus escolheu não escrever em arquivo de projeto exatamente para não entrar nessa disputa (`hook-status-config.ts:8-10`: “Emdash writes `.claude/settings.local.json` INTO the workspace instead; Nexus does not touch project files”).

### 3.3 — Armadilha do `-c` do Codex: sombra silenciosa

Os status hooks do Codex viajam como overrides `-c hooks.<Evento>=[...]` no argv (`hook-status-config.ts:80-87`). O próprio código avisa (`hook-status-config.ts:14-15`): **“a `-c` override shadows a same-key user hook for the session only”**. Isto é, um hook de `Stop` que o usuário tenha em `~/.codex/config.toml` fica *invisível* naquela sessão orquestrada — sem aviso na UI, sem log. Não afeta o `~/.codex/hooks.json` do Canal A (arquivo diferente), mas afeta `[hooks]` no TOML.

### 3.4 — A auditoria de 2026-08-05 está desatualizada no ponto central (achado de primeira classe)

[`2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md) afirma, na tabela “O Stop-hook existe, e é forte”:

> «Cliente | `hooks-gen.ts:260-266` + `HOOK_SCRIPT` (`:19-59`) | Hook `Stop` que consulta o gate por HTTP local e **`process.exit(2)` bloqueia a parada**.»

**Isso não é mais verdade em HEAD.** O commit `5ac0fd58` (“feat(hooks): forma por evento — stop desacoplado/fail-open, pretool intacto”, 2026-08-06 — **um dia depois da auditoria**) reescreveu o `HOOK_SCRIPT`:

- o branch de `stop` grava o payload em tmp, relança o próprio script `detached` com `NEXUS_HOOK_CHILD=1` e sai `0` (`hooks-gen.ts:69-90`);
- o neto faz a rede e **falha em silêncio** (`hooks-gen.ts:58-64`);
- `process.exit(2)` sobreviveu **apenas** no branch `pretool` (`hooks-gen.ts:104`, `:108`).

O próprio cabeçalho do script documenta a inversão (`hooks-gen.ts:22-33`): *“pretool = gate de AUTORIZAÇÃO → SÍNCRONO e FAIL-CLOSED… stop = obrigação de RELATO → DESACOPLADO e FAIL-OPEN. Gate fora do ar NUNCA trava o encerramento do worker.”*

**Efeito líquido:** `evaluateStop` (`gate.ts:619-639`) e a revalidação de handoff confiável (`mcp-server.ts:454-471`) continuam **corretos e ativos**, mas o veredito `allow:false` que produzem **não chega a lugar nenhum** — o cliente já saiu com `exit 0` antes da resposta existir. Hoje, em HEAD, **nenhuma configuração de nenhum CLI tem um Stop-hook bloqueante**. A matriz da auditoria (linha “Claude nativo, política `hardened` → Stop que BLOQUEIA: **sim**”) deve ser lida como **não** em HEAD.

Isso *amplia* o escopo do «delta que sobra (P1)» da auditoria em vez de resolvê-lo — mas também remove o risco que a própria auditoria apontava como motivo de não fechá-lo (worker preso com gate fora do ar). A garantia real permanece onde a auditoria já dizia: `src/main/orch/worker-handoff-enforcement.ts`, que não depende de hook.

### 3.5 — O `--settings` do HOME real segue sem gate

`writeClaudeFamilyZeroClickSettings` monta `hooks: mergeClaudeStatusHooks({})` — base **vazia** (`hooks-gen.ts:248`). Ou seja, o pane Claude em HOME real (`mcp-server.ts:809-816`) e o third-party GLM/LongCat (`mcp-server.ts:800-808`) recebem **só o Canal B**. O `nexus-gate.mjs` só é escrito em `prepareEphemeralHome` (`hooks-gen.ts:283-284`). O furo do `operator-choice` descrito na auditoria (`spawn-home-policy.ts:48-56`) continua exatamente como documentado.

### 3.6 — Dois servidores HTTP, dois tokens, e é de propósito

| | Canal A | Canais B + C |
|---|---|---|
| Servidor | próprio, `hook-http-server.ts:98` | MCP embutido, `mcp-server.ts:1147` |
| Token | por **app**, hex 24B, `hook-http-server.ts:81` | por **pane** (bearer do gate), `mcp-server.ts:712` |
| Header | `X-Nexus-Agent-Hook-Token` | `authorization: Bearer` |
| Onde o segredo vive | arquivo `0o600` sourced pelo shell | só no env do PTY, nunca em disco |
| Identidade do pane | `NEXUS_PANE_KEY` no corpo | implícita no bearer |

Confundir os dois leva a “o token está errado” em depuração: são tokens diferentes, para servidores diferentes, na mesma máquina.

### 3.7 — Compatibilidade Orca preservada no header

O servidor do Canal A aceita **também** `x-orca-agent-hook-token` (`hook-http-server.ts:149`), e o warn de versão fala em “another Orca install” (`src/shared/agent-hook-listener.ts:172-174`). Herança do fork (`stablyai/orca @ 143c36e5`, MIT). Um script Orca antigo ainda autentica se o token bater.

### 3.8 — Falha de install é engolida por design

`installManagedAgentHooks` captura tudo e só faz `console.warn` (`managed-agent-hook-controls.ts:74-82`). Se `~/.claude/settings.json` estiver corrompido, `readHooksJson` devolve `null` (`installer-utils.ts:59-61`) e o install lança (`claude-hook-service.ts:188-190`) — mas o usuário não vê nada além de um warn no console. A UI de Settings tem que ler `getManagedAgentHookStatuses()` para descobrir (`managed-agent-hook-controls.ts:104-112`). **lacuna** em §5.

### 3.9 — `blocked` e `waiting` viram `busy`, não “parado”

`mapAgentHookStatusToPaneSession` mapeia `blocked` e `waiting` para `busy` deliberadamente (`agent-hook-activity-mapper.ts:35-40`), “para a UI não parecer ociosa”. Quem depurar “o pane está busy mas nada acontece” precisa saber que *busy* aqui inclui *esperando aprovação*.

### 3.10 — 14 alvos declarados, 2 implementados

`AGENT_HOOK_TARGETS` lista 14 CLIs (`agent-hook-types.ts:10-25`) e o listener compartilhado tem extractores para claude, codex, gemini, antigravity, amp, cursor, copilot, opencode, command-code, grok (`src/shared/agent-hook-listener.ts:1207-1528`+). Mas o registro de produção instala **só claude e codex** (`register-default-installers.ts:26-27`). O resto do listener é capacidade herdada do Orca sem installer correspondente no Nexus — parte disso é coberta, por outro caminho, pelo Canal B.

---

## 4. Essencial vs incidental

**Essencial** (remova e o produto quebra ou perde garantia):

- `HOOK_SCRIPT` branch `pretool` + `handleGateRequest` case `pretool` — é o **único ponto de veto** de tool/skill no lado cliente (`hooks-gen.ts:91-110`, `mcp-server.ts:402-449`).
- `shouldUseEphemeralHome` — decide quem tem gate client (`spawn-home-policy.ts:37-59`).
- O invariante activity-only, afirmado independentemente em `agent-hook-activity-mapper.ts:14`, `hook-http-server.ts:183-191` e `hook-status-endpoint.ts:148-157`. É o que impede um hook de “declarar missão concluída”.
- Autorização por posse no IPC (`hook-ipc.ts:32-34`) e comparação em tempo constante do token (`hook-http-server.ts:11-16`).
- Consentimento antes de tocar config global (`hook-consent.ts:62-71` + `main.ts:809-829`) — é o que separa “ferramenta” de “malware bem-intencionado”.
- `mergeClaudeStatusHooks` preservando entradas de gate e de usuário (`hook-status-config.ts:48-55`) — sem isso, o Canal B apagaria o Canal C a cada spawn.
- Isolamento de falha do reducer (`hook-status-endpoint.ts:159-166`): o canal aditivo não pode derrubar o canal de enforcement que mora no mesmo servidor.

**Incidental** (útil, substituível, ou herança):

- O `posttool`: no-op server-side (`mcp-server.ts:451-453`). Existe para simetria e para um dia registrar handoff — hoje só custa um round-trip por tool call.
- Seed de trust do Codex (`codex-hook-service.ts:184-211`): contorno de versão específica (≥ 0.129), best-effort e explicitamente não-fatal.
- Aceitar `x-orca-agent-hook-token` (`hook-http-server.ts:149`): compat de fork.
- `MANAGED_HOOK_TIMEOUT_SECONDS = 10` (`installer-utils.ts:39`): número declarado que o curl (1,5 s) torna irrelevante na prática.
- Os 12 alvos sem installer em `AGENT_HOOK_TARGETS` (`agent-hook-types.ts:10-25`).
- Backup `.bak` (`installer-utils.ts:189`): rede de segurança, não parte do contrato.
- Cabeçalho win32 dos scripts gerenciados (`claude-hook-service.ts:60-72`): produto é macOS-first; caminho nunca exercitado aqui.

---

## 5. Lacunas

- lacuna: não verifiquei em runtime a **ordem real de execução** quando Overclock e Nexus registram hooks para o mesmo evento do Codex (`.codex/hooks.json` de projeto vs `~/.codex/hooks.json` de home). A precedência é decisão do binário `codex`, não do Nexus; falta confirmar empiricamente se projeto sobrescreve, precede ou concatena com home.
- lacuna: não li `src/main/orch/agent-status.ts:420` (`applyCanonicalHookEvent`) por inteiro — a máquina de estados semântica (quais transições são aceitas, o *latch* de `awaiting-input`, o bit `promptSubmitted`) é território de quem documentar status de pane, não de hooks. Aqui só está provado que o evento canônico chega até ela.
- lacuna: `src/shared/agent-hook-listener.ts` tem 3.473 linhas e li apenas até `:1528`. Os extractores por CLI a partir daí (copilot, command-code, amp, antigravity) não foram verificados linha a linha; a afirmação de §3.10 vale para os que li.
- lacuna: não confirmei se alguma superfície de UI expõe `getManagedAgentHookStatuses()` (`managed-agent-hook-controls.ts:104-112`) ao usuário, nem por qual canal IPC. Sem isso, uma falha de install fica invisível (§3.8).
- lacuna: `.codex/hooks.json` na raiz declara `PermissionRequest`, mas não verifiquei se o `codex` desta versão realmente emite esse evento — o installer do Nexus também o declara (`codex-hook-service.ts:37`) e pode ser evento morto em ambos.
- lacuna: não medi o custo agregado por turno. Um pane Claude governado dispara, no mesmo `PreToolUse`, um `curl` de gate síncrono (Canal C) **e** um `curl` de status (Canal B) **e**, se o Canal A estiver instalado, um terceiro `curl` — mais o do Overclock nesta máquina. Falta número real de latência somada por tool call.
- lacuna: `StopFailure` aparece nas specs de Claude do Canal A (`claude-hook-service.ts:30`) e de Kimi/Grok no Canal B (`flavors.ts:158`, `:224`), mas **não** nas specs Claude do Canal B (`flavors.ts:73-83`). Não determinei se é omissão ou se o evento não existe no Claude.
- lacuna: o `.grok/hooks/` do Nexus (`nexus.json`) e o do Overclock (`overclock-soft-status.json`) vivem em diretórios diferentes (overlay `GROK_HOME` vs projeto). Não verifiquei se o overlay faz o Grok enxergar *ambos* ou só o overlay.

---

## 6. Auditorias relacionadas

- [`../2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md) — matriz de propagação por CLI e o furo do `operator-choice`. **Ler junto com §3.4 deste doc:** a linha “Stop que BLOQUEIA: sim” está superada pelo commit `5ac0fd58`.
- [`../fase4-mcp-map.md`](../fase4-mcp-map.md) — padrão `McpToolDef` e a descrição dos endpoints `/gate/pretool|posttool|stop`; é a porta de entrada da frente F2.
- [`../2026-08-02-mcp-auth-failfast-and-parallel-panes.md`](../2026-08-02-mcp-auth-failfast-and-parallel-panes.md) — contexto do bearer por pane que os Canais B e C reutilizam. *(não lido nesta frente — referência de superfície)*
- [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) — **DESIGN ONLY, datado 2026-07-03**; usar como hipótese, nunca como prova. Duas divergências verificadas contra o código:
  - §E.3 (`docs/ARCHITECTURE.md:323`) diz *“PostToolUse (registra o handoff)”*. O código **não registra nada** no `posttool`: responde `allow:true` e retorna (`src/main/orch/mcp-server.ts:451-453`). O handoff é submetido pela tool `nexus_handoff_submit`, não pelo hook.
  - §E.3 (`docs/ARCHITECTURE.md:323`) e o quadro de §E.4 (`docs/ARCHITECTURE.md:384`) descrevem *“Stop (bloqueia a saída do worker se não houver handoff pendente, máx 3 tentativas)”*. A política das 3 tentativas existe (`src/main/orch/gate.ts:630`), mas **o cliente não bloqueia mais** (`src/main/orch/hooks-gen.ts:69-90`) — ver §3.4.
  - §E.4 (`docs/ARCHITECTURE.md:329`) descreve corretamente o `$HOME` efêmero + overlays privados por sessão para Codex/AGY/OpenCode/Kimi/Grok; isso **confere** com `spawn-home-policy.ts:37-59` e `cli-mcp-session-{kimi,grok}.ts`.
