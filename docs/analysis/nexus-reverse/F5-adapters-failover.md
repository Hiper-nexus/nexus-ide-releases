# F5 — Adapters multi-CLI + multi-conta/failover

## 0. Resumo (10 linhas)

1. Uma CLI **não é código**: é um JSON declarativo validado por Zod (`src/shared/adapter-types.ts:140`), compilado junto (`src/adapters/builtin/index.ts:12`) ou solto em `~/.nexus/plugins/adapters/` com hot-reload (`src/main/adapters/adapter-registry.ts:47,440`).
2. O JSON descreve **mecânica** (bin, detect, spawn, resume, env, quirks); ele **nunca** se auto-outorga autoridade — capacidades de release são calculadas Main-side em `adapter-registry.ts:94-135`.
3. Detecção não usa `which` no PATH do Electron: o app pergunta ao **login shell** (`path-resolver.ts:139-168`, `zsh -lic`) e funde com diretórios curados (`path-resolver.ts:72-104`).
4. Spawn usa sempre o **caminho absoluto** descoberto, nunca o nome nu (`adapter-registry.ts:548-566`; doutrina em `path-resolver.ts:6-20`).
5. Auth é **subscription-first** por decisão de produto: sessão nativa viva vence a key guardada e ainda **suprime** as env vars de key herdadas (`subscription-auth.ts:35-65`).
6. Segredos vão para `~/.nexus/secrets.enc` cifrados por `safeStorage` (Keychain do macOS) — `secrets-store.ts:293` cifra, `:103` decifra; sem storage seguro a operação é **recusada**, nunca degrada para plaintext (`secrets-store.ts:284-286`).
7. Claude é caso especial: a sessão vive no serviço de Keychain `Claude Code-credentials` e a troca de conta reescreve esse item (`claude-credential.ts:23,239`), sempre pela fatia slim e sem segredo em `argv`.
8. CLIs de auth-por-arquivo (codex/grok/kimi/opencode/agy) ganham um **home gerenciado por conta** (`managed-credentials.ts:149-203,387`), com env `CODEX_HOME`/`GROK_HOME`/… e scrub do plaintext ao morrer a sessão (`:693`).
9. Failover: o stream do pane (e o frame tipado do observer) é varrido por regex de limite (`limit-detector.ts:94+`); no hit a conta entra em cooldown e outra é escolhida (`failover.ts:724-812`).
10. Retomada: **mesma conta** → `--resume` nativo; **conta diferente** → sessão NOVA + continuity pack injetado, porque session id do provider pertence à conta (`failover.ts:52-53`, `failover-controller.ts:51-83`).

---

## 1. Trace ponta-a-ponta: de "declarar uma CLI" até "bytes do agente no pane"

### Fase A — Declaração e carga do adapter

| # | Passo | Arquivo:linha |
|---|---|---|
| A1 | O JSON builtin é importado em tempo de compilação e agregado em `BUILTIN_ADAPTERS` | `src/adapters/builtin/index.ts:1-22` |
| A2 | Bootstrap chama `initAdapterRegistry()`, que cria `~/.nexus` e `~/.nexus/plugins/adapters` | `src/main/adapters/adapter-registry.ts:429-437` |
| A3 | `reload()` carrega builtins e adapters do usuário | `adapter-registry.ts:350-377` |
| A4 | Cada JSON passa por `adapterSchema.safeParse` — inválido é **descartado com log**, não derruba o app | `adapter-registry.ts:174-184`; schema em `src/shared/adapter-types.ts:187-190` |
| A5 | `mergeAdapters()` deixa o adapter do usuário **sobrescrever** o builtin de mesmo `id` | `adapter-registry.ts:221-229` |
| A6 | A origem (`builtin` \| `user`) é registrada em `adapterOrigins` — é dela que dependem as qualificações de release | `adapter-registry.ts:356-363` |
| A7 | Hot-reload: `fs.watch` no diretório de plugins, debounce de 100 ms (`WATCH_DEBOUNCE_MS`) | `adapter-registry.ts:329,440-450,417-425` |

**Não-óbvio (A):** o adapter do usuário pode declarar mecânica, mas **não** pode se promover. `adapterCapabilityMatrixForAdapter` exige `origin === 'builtin'` para `governedWriter`/`autonomousReadOnly`/`verifiedMaestro` (`adapter-registry.ts:111-125`), e `verifiedMaestro` ainda depende de uma allowlist literal de dois ids: `VERIFIED_ORCHESTRATOR_BUILTINS = new Set(['claude','codex'])` (`adapter-registry.ts:55`).

### Fase B — Detecção no PATH do shell

| # | Passo | Arquivo:linha |
|---|---|---|
| B1 | App GUI herda PATH mínimo do Finder — doutrina explicitada no cabeçalho | `src/main/path-resolver.ts:6-20` |
| B2 | `probeLoginShellPath()` roda `$SHELL -lic "printf '%s%s%s' SENTINELA "$PATH" SENTINELA"` com timeout de 4 s | `path-resolver.ts:139-168` (comando em `:149-162`, `RESOLVE_TIMEOUT_MS` em `:23`) |
| B3 | O HOME forçado no probe é o **home real do passwd** (`realUserHome`), não `$HOME` — para E2E/smoke com HOME isolado ainda enxergarem os CLIs do operador | `path-resolver.ts:56-70`, uso em `:157` |
| B4 | `buildEffectivePath()` funde, nessa ordem: PATH do processo → PATH do login shell → diretórios curados existentes | `path-resolver.ts:178-197` |
| B5 | Lista curada inclui `~/.kimi-code/bin`, `~/.grok/bin`, `~/.claude/bin`, `~/.codex/bin`, `/opt/homebrew/opt/node@22/bin`, bun/cargo/deno/volta/nvm/fnm/asdf/npm-global/yarn, `~/.local/bin`, `~/bin` | `path-resolver.ts:72-104` |
| B6 | `resolveUserPath()` grava o resultado em `process.env.PATH` uma vez (idempotente) | `path-resolver.ts:222-228` |
| B7 | Para cada adapter, `resolveAdapterBin()` chama `resolveCliBinary(adapter.bin)` e guarda `{installed, binPath}` | `adapter-registry.ts:331-348`, `path-resolver.ts:329` |
| B8 | Reexame pós-instalação externa: `rescanAdapterBinaries()` → `refreshUserPath()` → re-probe → broadcast | `adapter-registry.ts:572-579`, `path-resolver.ts:234-242` |

**Não-óbvio (B):** o campo `"detect": "claude --version"` do JSON **não é executado** no caminho de discovery. O que decide `installed` é a resolução de `adapter.bin` no PATH efetivo (`adapter-registry.ts:331-340,250-256`). O `detect` sobrevive como metadado. — lacuna: verificar se algum outro caminho (instalador/doctor) executa `adapter.detect`; a busca desta frente não encontrou consumidor.

### Fase C — Decisão de auth (subscription-first)

| # | Passo | Arquivo:linha |
|---|---|---|
| C1 | `detectSubscriptionAuth(adapterId, home)` procura sessão nativa viva por provider | `src/main/adapters/subscription-auth.ts:567+` |
| C2 | Claude: item de Keychain `Claude Code-credentials` com blob **utilizável** (não basta o item existir) | `subscription-auth.ts:137-150`, utilidade em `claude-credential.ts:101-104` |
| C3 | `resolveAuthStrategy()` decide: `none` → credentialless; **subscrição viva → sempre vence** (`injectKey:false`, `suppressKeyEnv:true`); senão key guardada; senão `login-needed` | `subscription-auth.ts:35-65` (regra chave em `:56-57`) |
| C4 | O motivo está escrito no código: injetar `ANTHROPIC_API_KEY` num pane logado por OAuth **desviaria o billing** do plano para a API | `subscription-auth.ts:11-18`, `:52-55` |
| C5 | `provider-config-store` só consulta o vault quando a decisão é `injectKey` — para não travar a main thread num prompt de Keychain irrelevante | `src/main/persistence/provider-config-store.ts:718-729` (comentário em `:721-723`) |
| C6 | Com subscrição ativa, as env vars de key são listadas em `subscriptionSuppressEnvVars()` e removidas do ambiente do pane | `provider-config-store.ts:263`, aplicação em `:632,647,659,737` |

### Fase D — Materialização da credencial da conta escolhida

| # | Passo | Arquivo:linha |
|---|---|---|
| D1 | `prepareAccountForSpawn(adapterId, accountId)` valida dono, cooldown e modo | `src/main/persistence/account-store.ts:508-531` |
| D2 | Conta `api-key`: lê `acctkey:<id>` do vault cifrado | `account-store.ts:533-542`, prefixos em `:49-50`, leitura em `:293-294` |
| D3 | Conta `subscription` de provider file-auth: `fileSubscriptionAuthEnv(account)` devolve o env de home gerenciado | `account-store.ts:545-554` |
| D4 | Claude cuja conta **é** o login nativo do Keychain: **nenhum** token no env (a linhagem compartilhada é renovada pelo próprio CLI) | `account-store.ts:556-578` |
| D5 | Exceção do D4: pane em HOME isolado não enxerga o Keychain — aí o snapshot é a única ponte | `account-store.ts:569-589` |
| D6 | Conta Claude secundária: blob OAuth do vault (`acctcred:<id>`), renovado por sweeper de frescor a cada 15 min | `account-store.ts:591-598`, `:609-643`, `:649-671` |
| D7 | Home gerenciado é materializado: espelha o home nativo por symlink/cópia e escreve o auth com modo `0600` | `src/main/adapters/managed-credentials.ts:387-442`, escrita privada em `:239-249` |
| D8 | Env por provider: `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `XDG_DATA_HOME` (opencode), `GEMINI_CLI_HOME` (agy) | `managed-credentials.ts:149-203`, `:476-492` |
| D9 | O resultado vira `keyEnv` + `suppressEnv` no spec de spawn | `provider-config-store.ts:625-660` |

### Fase E — Spawn no pane

| # | Passo | Arquivo:linha |
|---|---|---|
| E1 | Argv nasce do template `spawn.interactive`/`spawn.headless` com placeholders `{{MODEL}}`/`{{PROMPT}}` | `src/shared/adapter-types.ts:288-295` |
| E2 | Se o template não tem `{{MODEL}}` e há modelo explícito, `models.flag` é anexado | `src/main/pty/pty-manager.ts:1062-1076` |
| E3 | `keyEnv` é aplicado ao ambiente do processo filho | `pty-manager.ts:1245-1249` |
| E4 | Sessão gerenciada é rastreada para o scrub posterior | `managed-credentials.ts:673-685` |
| E5 | Ao morrer a sessão, o auth em plaintext do home gerenciado é apagado — com refcount por conta, para dois panes na mesma conta não se sabotarem | `managed-credentials.ts:693-714` (refcount em `:654,684,698-703`) |
| E6 | Antes de apagar, um token renovado pelo CLI é lido de volta e persistido no vault | `managed-credentials.ts:448-473`, gatilho em `:705-712` |

---

## 2. Inventário

### 2.1 Tabela por CLI (fonte: os 9 JSONs de `src/adapters/builtin/`)

| CLI | Arquivo do adapter | `bin` | Comando interativo | `detect` | Auth declarada | Resume "última" (`resumeArgs`) | Resume exato (`resumeIdArgs`) | `sessionIdArg` | `nexusMcp` |
|---|---|---|---|---|---|---|---|---|---|
| **claude** | `src/adapters/builtin/claude.json` | `claude` | `claude --model {{MODEL}}` | `claude --version` | `oauth` / keychain | `--continue` | `--resume` | `--session-id` | `autoload` |
| **codex** | `src/adapters/builtin/codex.json` | `codex` | `codex` | `codex --version` | `api_key` (`OPENAI_API_KEY`) / keychain | `resume --last` | `resume` | — | `codex` |
| **agy** | `src/adapters/builtin/agy.json` | `agy` | `agy` | `agy --version` | `oauth` / keychain | `--continue` | `--conversation` | — | `none` |
| **kimi** | `src/adapters/builtin/kimi.json` | `kimi` | `kimi` | `kimi --version` | `api_key` (`KIMI_MODEL_API_KEY`) / keychain | `--continue` | `--session` | — | `kimi` |
| **grok** | `src/adapters/builtin/grok.json` | `grok` | `grok` | `grok --version` | `api_key` (`XAI_API_KEY`) / keychain | `--continue` | `--resume` | `--session-id` | `grok` |
| **aider** | `src/adapters/builtin/aider.json` | `aider` | `aider` | `aider --version` | `api_key` (`ANTHROPIC_API_KEY`) / **env** | *(vazio)* | — | — | `none` |
| **opencode** | `src/adapters/builtin/opencode.json` | `opencode` | `opencode` | `opencode --version` | `api_key` / **env** | `--continue` | `--session` | — | `opencode` |
| **glm** | `src/adapters/builtin/glm.json` | `claude` | `claude --model {{MODEL}}` | `claude --version` | `api_key` (`ANTHROPIC_AUTH_TOKEN`) / keychain | `--continue` | `--resume` | `--session-id` | `autoload` |
| **longcat** | `src/adapters/builtin/longcat.json` | `claude` | `claude --model {{MODEL}}` | `claude --version` | `api_key` (`ANTHROPIC_AUTH_TOKEN`) / keychain | `--continue` | `--resume` | `--session-id` | `autoload` |

Notas de leitura, todas verificadas no JSON:

- **glm e longcat não têm binário próprio**: rodam a CLI do Claude com `ANTHROPIC_BASE_URL` estático apontando para `https://api.z.ai/api/anthropic` e `https://api.longcat.chat/anthropic` (`glm.json` env.static; `longcat.json` env.static). Consequência de detecção: aparecem instalados sempre que `claude` resolver.
- **aider é o único sem resume nenhum**: `resumeArgs: []` e sem `resumeIdArgs` → `capabilities.resumable === false` por `adapter-registry.ts:104-107`.
- **grok exige `--trust-folder`** em `spawn.extraArgs` e declara `requiresNoAutoUpdate: true` (`grok.json` quirks).
- **claude injeta `--disallowedTools Task`** em `extraArgs` (`claude.json:38-41`) — o subagente nativo é desligado, porque a delegação é do Nexus.
- **aider é o único com idle por regex** (`^aider>`); todos os outros usam `timeout` de 800–1000 ms (`stateParsing.idle`).

### 2.2 Componentes

| Componente | Arquivo:linha | Responsabilidade |
|---|---|---|
| Schema declarativo | `src/shared/adapter-types.ts:140-190` | Contrato Zod de `cli-pty` e `api-provider`; valida todo JSON |
| Bundle de builtins | `src/adapters/builtin/index.ts:12-22` | 9 adapters embutidos no build |
| Registry | `src/main/adapters/adapter-registry.ts:350-377,429-490` | Carga, merge, hot-reload, broadcast |
| Matriz de capacidades | `adapter-registry.ts:94-135` | Separa mecânica (do JSON) de qualificação de release (Main-owned) |
| Resolução de PATH/binário | `src/main/path-resolver.ts:139,178,329` | Login shell + dirs curados + caminho absoluto |
| Decisão de auth | `src/main/adapters/subscription-auth.ts:35-65` | subscription-first + supressão de key env |
| Detectores de sessão nativa | `subscription-auth.ts:137,187,203,220,274,466,514,567` | Por provider (claude/agy/kimi/…) |
| Vault de segredos | `src/main/persistence/secrets-store.ts:283-301,307-325` | `safeStorage` + `~/.nexus/secrets.enc` |
| Keychain do Claude | `src/main/adapters/claude-credential.ts:107,239` | Ler/escrever `Claude Code-credentials` |
| Homes gerenciados | `src/main/adapters/managed-credentials.ts:149,387,476,693` | Multi-conta para providers file-auth |
| Store de contas | `src/main/persistence/account-store.ts:508-599` | `prepareAccountForSpawn`, cooldown, frescor |
| Seleção de conta | `src/main/persistence/account-select.ts:11-50` | Função **pura**: exclui a exausta e as em cooldown; prefere a com mais cota medida |
| Detector de limite | `src/main/orch/limit-detector.ts:94-183,400` | Regex por `quota` / `rate-limit` / `auth` |
| Motor de failover | `src/main/orch/failover.ts:390-644,724-860` | Cooldown → escolha → prepare → evento |
| Refutação | `src/main/orch/limit-refutation.ts` (via `failover.ts:21-25,742-786`) | API do provider pode **desmentir** o texto do PTY |
| Controlador no renderer | `src/renderer/orch/failover-controller.ts:19-101` | Pin da conta + respawn (resume ou continuity pack) |

### 2.3 Tools/env de multi-conta por provider

| Provider | Env de home | Arquivo de auth relativo | Fonte |
|---|---|---|---|
| codex | `CODEX_HOME` | `auth.json` | `managed-credentials.ts:150-156` |
| grok | `GROK_HOME` | `auth.json` | `managed-credentials.ts:157-163` |
| kimi | `KIMI_CODE_HOME` | `credentials/kimi-code.json` (candidato: `oauth/kimi-code`) | `managed-credentials.ts:164-180` |
| opencode | `XDG_DATA_HOME` | `opencode/auth.json` | `managed-credentials.ts:181-194`, alvo em `:324-326` |
| agy | `GEMINI_CLI_HOME` | diretório `antigravity` (snapshot) | `managed-credentials.ts:195-202`, `:508-523` |
| claude | *(sem home gerenciado)* | Keychain `Claude Code-credentials` | `managed-credentials.ts:19`, `claude-credential.ts:23` |

---

## 3. Não-óbvio / armadilhas

### 3.1 A key NUNCA vai a plaintext — prova por call site

Três afirmações independentes, cada uma com o call site:

1. **Cifra na escrita.** `persistDelta()` só grava depois de `safeStorage.encryptString(plainValue).toString('base64')` — `secrets-store.ts:293`. O arquivo alvo é `~/.nexus/secrets.enc` (`secrets-store.ts:20`), aberto com `wx` e modo `0o600` (`:228`), diretório forçado a `0o700` (`:219-220`).
2. **Falha fechada.** Se o storage seguro não está disponível, a escrita **retorna erro** em vez de degradar: `if (!isSecureStorageAvailable()) return { ok:false, error: SECURE_STORAGE_ERROR }` — `secrets-store.ts:284-286`, repetido em `setSecret` (`:365-367`) e `setKey` (`:407-409`). No Linux, o backend fraco `basic_text` é explicitamente rejeitado (`:45-50`).
3. **Nunca em `argv`.** Na troca de conta do Claude, o caminho primário passa o comando inteiro por **stdin** de `security -i` (`claude-credential.ts:156-172`), e o fallback escreve num arquivo temporário `0600` e faz o `bash` ler dele — o `argv` do Nexus carrega o caminho, não o segredo (`claude-credential.ts:200-229`, comentário em `:207-208`).

Complemento honesto (não é plaintext no vault, mas **é** plaintext transitório em disco): o home gerenciado dos providers file-auth precisa de um `auth.json` real para o CLI ler. Ele é escrito `0600` (`managed-credentials.ts:242`) e **apagado quando a última sessão daquela conta morre** (`:693-714`). O próprio código chama isso de "mitigação M1" e explica a janela em `:612-621`.

Para a UI, a key nunca sai inteira: `maskedKey()` devolve `abc…wxyz` (`secrets-store.ts:396-401`).

### 3.2 O `detect` do JSON é decorativo no discovery

Descrito em §1/B. Quem decide `installed` é a resolução do `bin` (`adapter-registry.ts:331-340`). Um adapter novo com `detect` errado ainda aparece instalado; um com `bin` errado nunca aparece, por mais correto que seja o `detect`.

### 3.3 `node-pty` não avisa que o binário sumiu

Comentário explícito em `adapter-registry.ts:533-538`: no macOS um bin inexistente **não lança** — o processo sobe e sai com código 1. Por isso o IPC de spawn precisa consultar `isAdapterInstalled()` antes, senão o operador vê "process exited (code 1)" em vez de "instale a CLI".

### 3.4 Cross-account não pode usar `--resume`

O session id do provider **pertence à conta**. `pty-manager.ts:1077-1078` diz isso na linha do código; o resume exato só é montado quando o session capturado pertence àquela conta (`resumeSessionLookup(scope, paneId, adapterId, req.accountId)` — `:1093-1098,1120-1125`). Na troca de conta o renderer faz respawn **fresco** com continuity pack (`failover-controller.ts:66-82`), não `--resume`.

### 3.5 Conta pinada que é o login nativo do Claude não recebe token env

Contraintuitivo e documentado no código como caso de campo: injetar o snapshot do vault num pane que já roda na linhagem nativa causava `401 OAuth access token has expired` no respawn de failover, porque env token não é renovado pelo CLI (`account-store.ts:556-562`). Regra: sem token env no HOME real (`:576-578`); **com** token env se o HOME for isolado, porque aí o pane não enxerga o Keychain (`:569-589`).

### 3.6 O PTY é um stream não confiável — e o código trata assim

Três defesas empilhadas em `failover.ts`:

- Refutação por API: se a API do provider diz que a conta está saudável, um hit vindo do scrollback é **suprimido** (`failover.ts:742-760`).
- Quarentena longa exige evidência tipada: cooldown longo vindo só de texto do PTY, sem janela fresca da API do provider, é recusado (`failover.ts:767-786`). O motivo está escrito em `:762-766`: o PTY mistura saída do provider, logs citados e prosa do agente.
- Rearme de 30 s (`REARM_MS`, `failover.ts:58,822,843`) e janela de 4000 chars (`WINDOW_CHARS`, `:57`).

Isso conversa diretamente com a memória de projeto "cascata de limite fantasma": o detector relendo o próprio continuity pack. — lacuna: confirmar que o continuity pack montado em `failover-controller.ts:66` está isolado da janela lida por `handleChunk` (`failover.ts:824`); o isolamento citado na memória fica em `src/shared/failover-handoff.ts`, fora do escopo lido nesta frente.

### 3.7 "Espera-pela-irmã": failover sem destino não desiste

Quando nenhuma conta está livre, em vez de falhar o motor agenda um retry para `min(fim do cooldown próprio, menor blockedUntil das irmãs) + 1s` (`failover.ts:551-562`, buffer em `:65`), limitado a `MAX_SCHEDULED_RETRIES = 8` (`:69,559`). Retries agendados **falham em silêncio**; só o hit original emite `switched:false` para a UI (`failover.ts:578-580`).

### 3.8 Coalescência de rajada — e por que sondagem não entra nela

Panes concorrentes que estouram na mesma conta reaproveitam a decisão A→B por 5 s (`COALESCE_MS`, `failover.ts:60,402-416,601-607`). Mas uma conta escolhida em modo **probe** nunca entra no coalesce: é uma request de teste, não um destino saudável para a rajada inteira (`failover.ts:598-601`).

### 3.9 Waiver e reroute podem preceder o retry

Se o pane é worker de missão, antes de agendar retry a política Main-owned é consultada: pode devolver `rerouted` (task passa a outro agente do mesmo roster) ou `waived` (advisory dispensada) — `failover.ts:492-550`. O comentário em `:479-491` explica por que a consulta vale em **todos** os attempts, não só no attempt 0. Isso é a implementação do P0-4 registrado na memória do projeto (reroute antes do waiver) e do bug de waiver mascarando task não executada — ambos aparecem aqui como código vivo.

### 3.10 Divergências vs. docs existentes

- **`docs/multi-account-matrix.md:10-13`** diz "resume conforme adapter" para grok/kimi/opencode/agy. O concreto está nos JSONs e vale a pena fixar: grok `--continue`/`--resume`, kimi `--continue`/`--session`, opencode `--continue`/`--session`, agy `--continue`/`--conversation` (§2.1).
- **`docs/multi-account-matrix.md:23`** afirma "failover → Conta B → spawn com resume flags do adapter". **Isso está desatualizado**: cross-account NÃO usa resume flags — usa sessão nova + continuity pack (`failover.ts:52-53`; `failover-controller.ts:58-82`). O resume nativo só vale no caminho same-account (`failover-controller.ts:51-57`).
- **`docs/multi-account-matrix.md:32-33`** lista "fetch de rate-limit em rede" como não suportado. O código já tem refutação por API do provider e score de cota medida (`failover.ts:329-361,742-760`; `quotaAvailabilityScore` em `failover.ts:40`). — lacuna: verificar se a cobertura é de todos os providers ou só de alguns antes de declarar o item resolvido.
- **`docs/adding-a-cli.md`** descreve bem o formato, mas não menciona a matriz de capacidades Main-owned (`adapter-registry.ts:94-135`) nem a allowlist `VERIFIED_ORCHESTRATOR_BUILTINS` (`:55`) — ou seja, um adapter de usuário nunca vira Maestro por mais completo que o JSON esteja.

---

## 4. Essencial vs incidental

**Essencial** (remova e o subsistema deixa de funcionar):

- O schema Zod e a validação fail-soft por adapter (`adapter-types.ts:187`, `adapter-registry.ts:174`).
- A separação mecânica-vs-autoridade (`adapter-registry.ts:94-135`) — é o que impede escalação de privilégio via JSON solto no home.
- Login-shell PATH + caminho absoluto no spawn (`path-resolver.ts:139,329`).
- `resolveAuthStrategy` (`subscription-auth.ts:35`): sem ele o produto desvia billing silenciosamente.
- Cifra obrigatória com falha fechada (`secrets-store.ts:284,293`).
- `chooseAccount` (`account-select.ts:11`) e `performSwitch` (`failover.ts:390`).
- Distinção same-account/cross-account na retomada (`failover-controller.ts:51`).

**Incidental** (útil, substituível, ou específico de um provider):

- A lista curada de diretórios (`path-resolver.ts:72-104`) — heurística que cresce com o ecossistema.
- O refresh remoto de catálogo de modelos e seus watchers (`adapter-registry.ts:452-489`): melhora UX de modelos, não afeta o spawn.
- O slim do blob do Claude (`claude-credential.ts:51-98`): existe por causa do limite de ~4 KiB da linha do `security -i` (`:29`), não por arquitetura.
- Coalescência e "espera-pela-irmã" (`failover.ts:60,551`): reduzem thrash e latência; sem elas o failover ainda funciona, só pior.
- `identityFromAuthBlob` (`managed-credentials.ts:96-147`): decoração de UI (e-mail da conta).
- A migração/quirk de Kimi (`kimi-runtime-env.ts`, `usesKimiTransientModel` em `pty-manager.ts:1066-1067`).

---

## 5. Lacunas

- lacuna: quem (se alguém) executa `adapter.detect` — no discovery ele não é usado; confirmar em `src/main/adapters/cli-install-recipes.ts` e nos fluxos de "Reexaminar CLIs".
- lacuna: isolamento do continuity pack vs. janela do detector de limite — a memória do projeto registra o bug da "cascata fantasma" e o fix em `src/shared/failover-handoff.ts`; não li esse arquivo nesta frente.
- lacuna: cobertura real da refutação por API do provider (`limit-refutation.ts`) — quais providers têm janela fresca de cota e quais caem sempre no caminho de texto.
- lacuna: `agy` declara `nexusMcp: "none"` no JSON; a auditoria `2026-08-05-mcp-hooks-propagation-audit.md:39` atribui isso a `cli-mcp-inject.ts:62`. Não verifiquei se o adapter é a causa ou o efeito.
- lacuna: `api-provider` (`adapter-types.ts:163-185`) tem `auth.keychainKey`, mas nenhum builtin usa esse kind (todos os 9 são `cli-pty`). Consumidor real do campo não confirmado.
- lacuna: `spawn.ptyRequired` é declarado por todos os adapters e validado pelo schema, mas não localizei o call site que o consome.
- lacuna: caminho Windows/Linux da troca de conta do Claude — `claude-credential.ts:31,240` retorna `false` fora do macOS; qual é o comportamento equivalente nos outros SOs não está coberto aqui (cross-referência: memória "Multi-plataforma obrigatório").
- lacuna: quantas contas o `pickAvailableForFailover` considera e como `allowProbe` interage com cooldown escopo-ciente — li a chamada (`failover.ts:421-430`), não a implementação em `account-store.ts`.

---

## 6. Auditorias relacionadas

- [`../../adding-a-cli.md`](../../adding-a-cli.md) — formato do JSON de adapter, hot-reload e catálogo de modelos. Complementa esta frente; ver divergência anotada em §3.10.
- [`../../multi-account-matrix.md`](../../multi-account-matrix.md) — matriz de produto multi-conta. **Contém afirmação desatualizada** sobre resume em failover cross-account (§3.10).
- [`../2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md) — matriz de qual CLI recebe MCP `nexus_*` e Stop-hook; cruza com a coluna `nexusMcp` de §2.1.
- [`../2026-08-02-mcp-auth-failfast-and-parallel-panes.md`](../2026-08-02-mcp-auth-failfast-and-parallel-panes.md) — fail-fast de auth e panes paralelos.
- [`./F3-hooks-lifecycle.md`](./F3-hooks-lifecycle.md) — hooks por CLI (frente irmã).
- [`./F6-pty-grid-canvas.md`](./F6-pty-grid-canvas.md) — o spawn descrito na Fase E desemboca lá.
