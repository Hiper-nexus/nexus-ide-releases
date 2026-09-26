# AGENTS.md — NexusIDE

Electron IDE monorepo: multi-agent terminal grid, PTY management, MCP
orchestration, and a React renderer. The backend server and mobile companion
are separate workspaces.

## Project Layout

| Path | Responsibility |
|------|---------------|
| `src/main/` | Electron main process (bootstrap, IPC, orchestration, PTY, sandbox) |
| `src/renderer/` | React renderer (UI, state stores, terminal host) |
| `src/preload/` | Preload bridge (context-isolated IPC surface) |
| `src/shared/` | Cross-process contracts, types, and schemas |
| `server/` | Express backend (auth, billing, cron, sync control-plane) |
| `mobile/` | Expo/React Native companion app |
| `shared/` | Shared contracts between server and client |
| `scripts/` | Build, release, security, and dev-environment scripts |
| `docs/` | Architecture, security, and design documentation |
| `resources/` | Static resources and bundled assets (skills, shell integration) |
| `resources/agent-detection/` | Herdr (Apache-2.0) agent screen-state manifests; evaluated by `src/main/detect/` |
| `native/` | Native C code (darwin-pty-supervisor) |

## Security-Sensitive Core Boundary

The following directories mutate the user's real shared config, escape sandbox
HOME confinement, or manage process isolation. Changes here require a relevant
check before delivery:

| Path | Risk |
|------|------|
| `src/main/orch/` | Orchestration coordinator, MCP server registry, CLI agent spawn, **transactional MCP lease** that writes a bearer token into the user's real `mcp_config.json` |
| `src/main/pty/` | PTY session manager, advisory process sandbox (macOS Seatbelt / Linux Bubblewrap / Windows OCI) |
| `src/main/runtime/` | Process sandbox enforcement, `processHome` escape from macOS Seatbelt HOME confinement |

## Install and Rebuild

```bash
npm install                    # runs postinstall: electron install + node-pty patch
npm run rebuild:electron       # rebuild native modules for Electron
npm run rebuild:node           # rebuild native modules for Node (CI/tests)
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Full vitest suite |
| `npm run test:changed` | Only tests affected by changed files (git-based) |
| `npm run security:renderer-sinks` | Static check for unsafe renderer IPC sinks |
| `npm run lint` | Alias for `tsc --noEmit` |
| `npm run start` | Dev server (hot reload) |
| `npm run make` | Build and package with Electron Forge |
| `npm run release:candidate` | Gate do candidato (assinatura, staple, smoke do ZIP, receipt) |
| `npm run release:security` | Security gate (renderer sinks + audit) |

## Authoritative Owners

- **Visual design tokens and component styles**: `DESIGN.md`
- **Architecture and module boundaries**: `docs/ARCHITECTURE.md`
- **Security boundaries and threat model**: `docs/SECURITY.md` holds the
  fail-closed contract and the ownership table. The substantive analysis lives
  in `docs/security-audit-2026-07-16.md` (threat model and findings),
  `docs/security/OWASP-ASVS-L2-PROFILE.md` (control profile), and
  `docs/security-best-practices-report.md`. Read those before changing anything
  under `src/main/orch/`, `src/main/pty/`, `src/main/runtime/`, or
  `src/main/remote/`.
- **QA bug workflow**: `docs/QA-PROTOCOL.md`
- **Release readiness gate**: `docs/RELEASE-CHECKLIST.md`
- **Co-located tests**: every source file has a `.test.ts` sibling — run it
  after editing the source.

## QA and Release Process (from Overclock adaptation)

- Register bugs as `docs/qa/items/F-XXX.md` using the format in
  `docs/QA-PROTOCOL.md`. 1 bug = 1 file, never append to a single ledger.
- Validate fixes with `npx tsc --noEmit` and `npx vitest run path/to/file.test.ts`
  before marking `corrigido`.
- For renderer or IPC changes, also run `npm run security:renderer-sinks`.
- Use `git add` per finding, never `git add -A` or `git add .`.
- Before declaring a release ready, walk through `docs/RELEASE-CHECKLIST.md`.

## Resolução de Travamentos e Paridade Overclock

- `src/main/usage/usage-service.ts`: telemetry agora absorve erros de scope
  identity collision (`snapshot`, `notifyMediaGenerated`, `#onSessionDictated`)
  em vez de propagar exceções que travam a UI de quota/custo.
- `worker-handoff-ttl.ts` (opt-in) espelha Overclock 1.2.4: workers idle com
  handoffs consumidos são encerrados após ~30s, liberando panes e contexto.
- Para diagnóstico no app Overclock empacotado, use o script local
  `~/.overclock-app/overclock-doctor.mjs` (report/limpeza de marcadores órfãos
  e missões travadas).

## Multi-conta: o que prova um login novo

Quem tocar em Providers, no menu "+ Pane" ou no terminal de login precisa
saber isto antes de mexer:

- **Uma CLI guarda UMA sessão por vez.** Entrar na 2ª conta sem guardar a 1ª a
  perde para sempre. Por isso `AccountsManager` preserva a sessão atual
  (`addActiveSession`) ANTES de abrir o login de cadastro. O motor deduplica
  por subject/blob e mantém o rótulo da linha existente, então preservar é
  idempotente.
- **Fechar o terminal, estourar o tempo ou reencontrar `authReady` não provam
  login nenhum.** A prova é `cliLoginProvedNewSession(baseline, atual)` em
  `src/renderer/components/settings/cli-login-terminal.ts`: sonda `ok` mais
  identidade de sessão que surgiu ou mudou em relação ao baseline colhido
  ANTES de abrir o terminal. Sem prova, a UI diz que não deu — nunca grava uma
  conta que talvez seja a mesma.
- **A identidade é `AdapterAuthStatus.sessionFingerprint` (opaco, só
  igualdade), com o e-mail da sonda como segundo caminho.** Nunca exiba,
  registre nem persista o fingerprint. É ele que distingue A de B em CLI sem
  e-mail (Kimi, OpenCode) e prova reautenticação da mesma conta.
- **Conta sem e-mail é conta.** `addActiveSession` aceita rótulo e devolve
  `id`; use o `id` para selecionar a conta, nunca o nome.
- **Sem `supportsSnapshot` não há duas sessões nativas em paralelo.** Diga
  isso na interface e aponte a API key; não prometa isolamento que o adapter
  não implementa.
- A ação administrativa do "+ Pane" vive na decoração local
  (`withAccountActions`), fora de `buildPanePickerEntries` — aquele catálogo é
  compartilhado com a grade de terminais, onde cada linha é um terminal.
- **Recibo da escolha de conta** (`account-choice-receipts.ts`): a regra de
  folga decide (Jev NÃO escolhe conta — comparar cota medida é aritmética);
  `prepareProviderSpawn` devolve `overrides.accountChoice`, registrado por
  sessionId no spawn e devolvido em `nexus_pane_spawn` (`harness.account`) e
  `nexus_pane_whoami`. Rótulos sempre mascarados (`maskAccountLabel`); nunca
  id, fingerprint ou token.
- **A conta ativa fica até a cota medida zerar.** `chooseAccount` não entrega
  o pane à irmã só porque ela tem mais folga. Troca quando a ativa está fora
  da lista (cooldown, sem credencial, excluída pelo hit) ou quando a
  disponibilidade medida é 0. Cota desconhecida mantém a ativa. Sem conta
  ativa, a mais livre vence.
- **A conta que É o login nativo não ganha escopo gerenciado (F-645).**
  Refresh token rotaciona: duas cópias dele (o store nativo e um
  `managed-accounts/claude/<id>/auth` semeado do vault) não sobrevivem juntas —
  quem renova primeiro mata a outra, e se for o pane ou a sonda de cota, cai o
  login do operador. `claudeAccountIsNativeLogin` decide (dono do token vence
  e-mail antigo); o pane dessa conta usa o store nativo (`{}` ou access token
  por env em HOME isolado) e a cota lê só o perfil nativo. Não volte a
  materializar escopo nem rodar `claude /usage` em escopo para ela.
- **Fora do macOS o login nativo é gravado no lugar (F-646).** A CLI regrava
  `.credentials.json` por temporário + rename, então link ou cópia no overlay
  vira segunda linhagem na primeira renovação. Pane direto com login nativo
  recebe `CLAUDE_SECURESTORAGE_CONFIG_DIR=<~/.claude real>` e o overlay não
  recebe o arquivo (`nativeCredentialsInPlace`).
- **Token de acesso vencido não é sessão perdida (F-639).** Com refresh token,
  o spawn deixa a própria CLI renovar (um run no store que o pane vai usar) e
  prova a identidade no token novo; "entre novamente" só se nem ela conseguiu.
- **«Entrar novamente» da mesma conta abre o login mesmo se o snapshot vivo
  falhar.** O aviso «Não consegui guardar a conta atual» continua quando o
  cadastro de uma segunda conta não consegue gravar a primeira, e quando o
  e-mail da sessão viva é de outra conta. Sessão `missing` não tem o que
  guardar e não bloqueia o login.

## Conventions

- Co-located tests: `foo.ts` → `foo.test.ts` in the same directory.
- Run the focused test before delivery: `npx vitest run path/to/file.test.ts`.
- Run `npm run typecheck` after any source change.
- The build chain (`premake` / `prepackage`) enforces typecheck, renderer-sink
  security, and native checks before build or package.

## Project Skills

- **Landing page / marketing UI**: Whenever a request involves landing pages,
  marketing sites, web UI, page sections, components, prototypes, or UI copy,
  invoke the `landing-page-design` skill from `.devin/skills/landing-page-design/SKILL.md`
  before designing or writing a single line of code. Do not ask the user to point
  to it manually.

## Via Rápida: escritores isolados

- `nexus_pane_spawn({ isolatedWriter: true })` sem contrato congelado cria
  uma worktree por spawn pelo `WorktreeManager` (GitRunner + CoW opcional).
  `readOnly` explícito ou herdado prevalece e não aloca worktree.
- Registros `ownerKind: 'pane'` usam um taskId técnico, sem criar task de plano;
  a varredura de tasks órfãs deve preservá-los. Branches usam hashes curtos dos
  ids de missão/worker, derivados por `worktreeBranchRef` nos validadores também.
- A base é HEAD do escopo; WIP do checkout de coordenação não é copiado nem
  exige limpeza. O caminho selado mantém a exigência de checkout limpo.
- `isolated-writer-worktree.ts` libera a reserva por `markFailed` no tap de
  saída física do PTY, inclusive fechamento/teardown de missão, ou em falha
  de spawn sem pane vivo. ACK pendente mantém a reserva de worktree.
  Recovery no registry libera reservas de pane de um processo anterior.
  Branch e diretório ficam preservados para integração manual pelo Maestro;
  liberar a reserva não autoriza apagar commits ou WIP não integrados.

## Handoff sem missão (F-565)

- `nexus_pane_spawn` guarda `operatorParentSessionId` no metadado do Main para
  filhos do operador sem missão. Esse vínculo não vem dos argumentos MCP nem
  do renderer; panes existentes sem vínculo não ganham um pai por inferência.
- O handoff de workspace usa o ledger atual com `mission_id = NULL` no banco
  do checkout. `list({ missionId: null })` seleciona somente essas linhas;
  `undefined` preserva a consulta de auditoria do store.
- A entrega ao pai usa `injectPrompt` (mesmo transporte de `nexus_pane_write`),
  revalidando sessão, checkout e ausência de missão/contexto obsoleto durante
  a operação. Falha de transporte mantém a linha `queued` e retorna
  `delivered: false` com `deliveryError`; o operador ainda pode listar a linha.
- Esse caminho nunca emite evidência/recibo de missão, ACK, avanço de task ou
  conclusão. A auditoria MCP continua no dispatcher; o handoff é `unverified`.

## Uma missão nunca mistura workspace (F-634/F-635)

- A árvore de layout do renderer é UMA só. Ao trocar de projeto, o que está
  nela quando a troca começa é do workspace que SAI (`outgoingPaneIds` em
  `switchWorkspaceLayout`): `hydrate` nunca carrega esses panes para o alvo,
  nem os de missão. Só a missão que aterrissou durante a leitura sobrevive.
- Todo caminho que espera (settle do layout, IPC, STT, cópia de anexo) e só
  depois monta ou digita num pane confere o escopo de novo:
  `isPresentationScopeCurrent` na recovery/apresentação, workspace no
  `reopenMission`. Digitação do renderer (`writeToPane`, `submitPromptToPane*`)
  recusa host estacionado — a sessão continua viva, mas é de outro projeto.
- Em Autopilot a missão criada pela mão do operador (`nexus_mission_create`,
  role `user`) nasce `running` com contrato aprovado e despachado em modo
  livre (`freeAgentChoice`) e sem squad, salvo `squadId` explícito (F-649).
  Sem contrato todo worker voltava `approval_required`; com o `nexus-fullstack`
  imposto vinham `squad_binding_violation` e `route_reservation_required`.
  Validar "a missão nasce rodando" só no intent gate não prova nada — o spawn
  real exige contrato. Hardened mantém squad padrão e despacho na interface.
- Missão `done`/`failed` devolve a mão do operador ao pane que ela promoveu
  (`returnOperatorHandFromEndedMission`, no `dispatchToolCall`, F-650).
  `blocked` mantém o vínculo: é a espera pela resposta do operador. O Nexus
  opera pelo "+ Pane" E por missão; missão nunca deixa o pane do operador estéril.
- Missão parada tem saída na mão do próprio pane (F-651): ele retoma a `blocked`
  (`running`, `operatorHand` no intent gate) e toda recusa de intenção traz o
  `hint` com a chamada exata. Recusa nunca manda pedir "despacho" ao operador —
  missão criada pelo MCP não tem botão de despacho. A invariante em
  `mcp-dispatch-security.test.ts` percorre todo status; trava nova no caminho
  do pane do operador precisa passar nela.

## Abas dos Terminais: aba = feature (23/09)

- `WorkspaceTabs` substituiu o rack de cartões (`MissionLaneBar`), os pinos
  A/B e o "Todos". Uma aba por escopo de `listPaneScopes`; visão geral é
  `ALL_SCOPES_KEY`; "ver ao lado" é `sideScopeKey` e desenha duas `PaneGrid`
  (a secundária com `primary={false}`, que não atende o `pendingOpen` do
  picker — senão dois menus abririam juntos).
- Missão começada por um pane do operador mora na aba DELE: a adoção em
  `reflectMissionLeader` carimba `missionHost` (persistido no layout) e
  `missionHomeScopeKeys` manda missão e workers para o escopo do anfitrião.
  Missão do assistente não tem anfitrião e mantém a aba própria. Classifique
  vários panes com `paneScopeResolver`, nunca com `paneScopeKey` solto (sem
  as casas, a missão hospedada iria para uma aba que não existe).
- Aba com missão viva não fecha pelo ×: encerrar é no Quadro. "Terminais"
  (panes sem espaço) renomeada vira um espaço (`nameLooseSpace`).
- Branch + worktree por aba AINDA NÃO existe — o Main recusa cwd fora da
  raiz e a worktree gerenciada mora fora dela. Desenho e bloqueios em
  `docs/analysis/2026-09-23-abas-feature-worktree.md`; não contorne criando
  worktree dentro da raiz do projeto.

## Conversas Grok/Kimi por checkout (F-566)

- Os overlays recebem `userDataPath` e `checkoutId` da autoridade do Main e
  ligam suas conversas a `<userData>/provider-state/<adapter>/<checkoutId>/`.
  Nunca volte a ligar `sessions`/históricos/índices ao perfil nativo: um CLI
  externo no mesmo cwd pode retomar a conversa viva do pane.
- Auth e extensões seguem a política existente do perfil. O sandbox governado
  precisa conceder tanto o perfil quanto o diretório durável exato do checkout.
- As entradas de conversa ficam excluídas do sync-back ao perfil real, inclusive
  quando o CLI substitui um link de arquivo por rename atômico. Limpar overlays
  não apaga sessões duráveis. Sessões antigas no perfil nativo ficam intactas;
  não são importadas automaticamente para o Nexus.

## Redline na barra depois de atualizar o Nexus (F-612)

- O `swiftc` do companheiro leva `-target arm64-apple-macosx14.0`, o mesmo piso de `LSMinimumSystemVersion`. Sem esse alvo o linker carimba `minos` com a versão do SDK (0.76.75 saiu `minos 27.2` num Mac 27.0) e o Launch Services recusa o app com «Você não pode usar esta versão do aplicativo» (F-628). O build confere o `minos` com `vtool` e falha se não for 14.0.
- Quem já instalou o companheiro em `/Applications` precisa de
  `syncInstalledRedline` no boot: se o binário empacotado diferir, substitui e
  relança. A oferta one-time não cobre update. `open` num LSUIElement já
  rodando não reconstrói o extra — "Abrir Redline" mata e abre de novo.
- A faixa só pinta contas com `usedRatio` (`statusBarEntryIds`, teto 6).
  Unknown (`·····`) fica no painel, senão o extra some no overflow do macOS.
- F-029 mudou a anatomia: o clique abre um `NSPopover` com lista vertical e
  rolagem (`QuotaPanelController`), não mais um `NSMenu` — `statusItem.menu`
  foi embora e as ações são botões de verdade fora da área rolável.
- A faixa virou UM resumo: `<glyph> <barra 5 blocos> <pct>` da pior janela
  entre as contas de `statusBarEntryIds` (`entriesForBar`). Um segmento por
  conta media ~930pt com 6 contas; o teto da spec é 100pt e não cabe
  cronômetro no título — o reset fica na linha da janela no painel.
- `urgencyColor` é NSColor dinâmica resolvida pela aparência da superfície
  que desenha, com hexes fixos nos DOIS temas (não mais "tons do sistema no
  escuro"): a barra pode ser clara sob papel de parede claro mesmo com o
  macOS em dark mode.
- O PAINEL é superfície Nexus escura SEMPRE (`.darkAqua` no root e no popover;
  `#111013` cabeçalho/rodapé, `#0d0b0f` lista, fios branco a 8%). Seguir a
  aparência do sistema foi o defeito que reabriu o F-029: no tema claro o painel
  virava folha branca, contra o dark-first do `DESIGN.md`. Não use cor dinâmica
  do sistema (`labelColor`, `windowBackgroundColor`) dentro do painel — o spec
  percorre todo label renderizado e reprova o que não limpar 4,5:1 contra a
  superfície, e mede a tinta de cada botão contra o próprio preenchimento.
  `urgencyColor` é da FAIXA (segue o tema do menu bar); o painel tem paleta
  estática própria. O medidor é view desenhada, não bloco `▮`.
- Logo de provider no companheiro NÃO é SVG. O AppKit lê mal os SVGs de
  `src/renderer/assets/provider-logos/`: reporta `size 1x1` e o
  `gemini-color.svg` desenha 14 de 1024 pixels — some na prática.
  `scripts/build-redline-logos.mjs` rasteriza por Chromium (Electron, já
  dependência) para PNG 48px em `native/menubar-redline/assets/provider-logos/`
  com manifesto e guarda de cobertura ≥5%; rode à mão quando um logo mudar.
  `scripts/build-redline-logos.test.ts` acusa deriva contra `ProviderLogo.tsx`.
  Marca `mono` exige `isTemplate` + tinta clara, senão preto sobre near-black
  desaparece; o `NOTICE.md` de procedência viaja com elas para o bundle.

## Overlay Kimi leva o catálogo de modelos (F-611)

- `$KIMI_CODE_HOME` do pane é o overlay efêmero, não `~/.kimi-code`. Sem
  `models`/`providers` no `config.toml` do overlay, `kimi --model kimi-code/k3`
  cai em `config.invalid` mesmo com o catálogo nativo intacto.
- `prepareKimiMcpSession` projeta `models`, `providers`, `services` e
  `default_model` do perfil nativo (segue symlink de conta gerenciada) para a
  cópia privada do overlay, junto dos hooks de status. Não deixe o merge de
  hooks falhar em silêncio e nascer overlay sem catálogo.
- A TUI do Kimi pode substituir o `config.toml` do overlay (rename atômico) e
  apagar o catálogo. O guarda no overlay reescreve modelos/providers nativos e
  preserva o `default_model` que a TUI escolheu. Nunca sync-back desse arquivo.

## HOME efêmero da família Claude: o pane escreve como o operador (F-579/F-580)

- O overlay `~/.nexus/ephemeral/<tok>` isola CONVERSA e auth Claude (F-567),
  não é fronteira de segurança: pane Claude gravável nunca é confinado pelo
  kernel (Seatbelt só em lane readOnly e Codex). Por isso `prepareEphemeralHome`
  projeta a identidade do operador em dois tiers, ambos fail-closed por default:
  `carryDeveloperIdentity` (`.gitconfig`, `.git-credentials`, `.netrc`,
  `_netrc`, `.ssh`, `.gnupg`, `.config/git`, `.config/gh`) para toda lane
  gravável, e `carryNativeHome` (POSIX; todo o topo do HOME real menos
  `.claude`, `.claude.json*`, `.nexus`, `Library`, `.Trash`) só para a lane
  sem gate hooks (`!gateHome`). Lane readOnly não recebe nada.
- `Library` fica fora do tier 2 de propósito: o keychain entra arquivo a
  arquivo pela política do F-575 (só `carryNativeClaudeAuth && gateHooks
  false`); third-party (GLM/LongCat) nunca vê keychain nem `.claude.json`.
- Links são symlinks (win32: junction/hardlink) e o teardown (`fs.rmSync`) não
  os segue — teste em `hooks-gen.developer-identity.test.ts` confere o HOME
  real depois do `cleanupSessionArtifacts`. Não substitua por cópia.
- `ProcessGitRunner` (Main) HONRA config global e de sistema do git: é ela que
  carrega o credential helper (`gh auth git-credential`, osxkeychain, GCM) e
  `user.name/email`. Não volte a setar `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`
  — o modelo de ameaça desconfia do conteúdo do REPO (`assertSafeLocalGitConfig`
  + `-c` pinados), não do `~/.gitconfig` do usuário.
- `nexus_git_sync` (fast-forward verificado) é alcançável pela mão do operador
  em vibe; só `ui_action` mantém autoridade de origem renderer (F-581).

## Colar/arrastar mídia no pane (F-582)

- O pane aceita QUALQUER tipo de arquivo (vídeo incluído) — o whitelist de
  `classifyMissionAttachment` vale só para wizard/App; no terminal,
  `filesFromClipboardData(data, { anyKind: true })` classifica o resto como
  `file` e nomes genéricos viram `print`/`audio`/`documento`/`anexo-<stamp>`.
- O paste espelha o drop, nesta ordem: `files` → `text/uri-list`/`DownloadURL`
  → imagem embutida no `text/html` → pasteboard do sistema via Main
  (`clipboardFileUris`: macOS `public.file-url`, win32 `FileNameW` UTF-16LE,
  linux `text/uri-list`). `text/plain` NUNCA é interceptado — URL ou caminho
  colado como texto segue digitado no terminal (a assimetria drop/paste é
  deliberada; `pasteUrisFromClipboard` não tem o fallback `text/plain` do
  `resolveDropUris`).
- File com caminho real é path-first: dentro do projeto injeta o relativo;
  fora, faz stream pelo Main (`importDroppedUri` →
  `importWorkspaceMissionAttachmentFromFile`, blocos de 1 MiB) até 256 MiB.
  Blob sem caminho (base64) e downloads http(s) ficam em 14 MiB. Sem nada
  aproveitável, o toast "Nada foi colado no terminal" explica — WhatsApp sem
  arquivo materializado pede para salvar e copiar/arrastar do Finder.

## Muse pane imprime `--help` e sai code 2 (F-596)

- Muse Code (`muse`) **não** é Claude: não tem `--mcp-config` / `--settings` /
  `--strict-mcp-config`. Marcá-lo `mcpAutoload: true` / `nexusMcp: autoload`
  faz o spawn injetar essas flags; o binário 1.3 recusa, dumpa o help
  (incluindo `--subagent-worktree-isolation`) e sai 2.
- Adapter `muse`: CLI própria (`bin: muse`, `mcpAutoload: false`). Handoff
  cai no fallback PTY/nx-mail. `spawn.extraArgs` inclui `--trust-workspace`.
- Opcional `muse-claude`: Claude Code apontado a `https://api.meta.ai`
  (Muse Spark). Key `ANTHROPIC_AUTH_TOKEN` (Model API da Meta). Não mistura
  com a sessão Anthropic nativa (família terceiro + HOME isolado).
- Lei do binário: `--mcp-config`/`--settings` só no argv de `claude` e
  `openclaude`. Copiar `mcpAutoload: true` no adapter `muse` não injeta
  flags Claude.

## Codex pane: `url is not supported for stdio` em mcp_servers (F-594)

- Pane direto do operador (`preserveUserMcp`) copia o `config.toml` real,
  inclusive `[mcp_servers.supabase] command = …` (stdio). O hub do workspace
  pode declarar o mesmo id como `streamable-http` (`url`).
- `codexHubMcpArgs` injeta `-c mcp_servers.<id>.url=…` por cima. O Codex
  recusa a mistura no load (`Error loading config.toml: url is not supported
  for stdio in mcp_servers.supabase`) e o pane sai com code 1.
- Fix: no spawn da mão do operador, pular chaves do hub que já existem no
  config preservado. Workers (overlay sem ambient MCP) continuam recebendo
  o hub inteiro. Export do hub (`mergeCodexToml`) também não grava url+command
  no mesmo bloco.

## Paste/drop no pane já morto mente sobre "cópia falhou" (F-593)

- `injectDroppedFile`/`injectDroppedUri` (`terminal-host.ts`) copiam o
  arquivo/URI para `.nexus/attachments/mission-context/` (`importDroppedUri`)
  e só DEPOIS chamam `injectStagedPath`, que escreve no PTY via
  `host.sessionId`. Quando o PTY já saiu (Codex/CLI morto), `setHostSession`
  zera `host.sessionId` e `injectStagedPath` faz early-return em silêncio.
- Bug: o código tratava esse caso como se a cópia tivesse falhado —
  `droppedFileRejectionMessage` ("não pôde ser copiado para a missão") saía
  no toast mesmo com o arquivo já staged com sucesso no disco. O operador via
  um erro de cópia mentiroso quando o problema real era pane sem processo.
- Fix: checar `host.sessionId` no momento de injetar, não só no de copiar.
  Se `result.ok` mas sessão morta → toast "Pane sem sessão ativa" dizendo que
  o arquivo FOI copiado e pedindo para reabrir o agente — nunca reusar a
  mensagem de recusa de intake para esse caso.

## Política de Git do fan-out isolado (F-563)

- No MCP, writers com `executionScope` distinto usam apenas Git
  add/commit/status/diff/log na worktree e branch do registro do Main; HEAD
  destacado, branch trocada e repo aninhado são recusados.
- `nexus_terminal_run` desses writers não executa shell: traduz somente argv
  Git literal para os mesmos handlers protegidos. Chains, subshells, scripts e
  `nexus_bg_run` são recusados. Não substitua isso por regex ou wrapper de PATH.
- Essa proteção cobre os processos lançados pelo MCP. A execução interna dos
  CLIs depende de seus próprios hooks/perfis; Autopilot não implica sandbox
  de kernel. Não declare que um guard MCP confina todas as ferramentas nativas.
- Worker→worker write/close exige a mesma `executionScope.rootRealPath`.
  Read/wait continuam disponíveis dentro da missão. O handoff do writer deve
  listar arquivos tocados e diff; branches isoladas não têm merge automático.

## Grok: não spawna `grok models` (ciclo 5)

- O binário `grok models` faz silent refresh e rotaciona o refresh token a
  cada invocação. O poll antigo (5 min) + TTL 5 min caía a cada ~10 min.
- Descoberta de modelos do Grok lê `~/.grok/models_cache.json` (e o catálogo
  bundled). Nunca `execFile('grok', ['models'])`. Cota usa
  `GET cli-chat-proxy.grok.com/v1/billing` com o JWT já em `auth.json`.
- `MODEL_DISCOVERY_POLL_MS` / `MODEL_DISCOVERY_TTL_MS` ≥ 1 h para o restante
  das CLIs com comando list.

## Grok: cota renova pela CLI, sem pedir login por access token vencido (F-626)

- O fallback de cota usa ACP `grok agent --no-leader stdio`, apenas
  `initialize` e `authenticate` com `cached_token`; nunca `session/new`, prompt
  ou `grok models`. A CLI continua dona da renovação e do arquivo de auth.
- Panes e sondas do Main compartilham o gate da família de refresh, inclusive
  cópias native/managed. Revalidar subject, issuer, client e team e recusar
  arquivo alterado enquanto espera. CLI externo não participa desse gate.
- Uma leitura provider-api real pode refutar cooldown de autenticação; presença
  de arquivo/e-mail não pode. Preservar quota global e por tier, e publicar ao
  Redline as contas relidas após a cura. Falha em persistir a cura não apaga a cota.

## Codex: um refresh OAuth por conta gerenciada (ciclo 5 addendum)

- O binário Codex (não o Nexus) rotaciona o refresh token do ChatGPT ao
  boot quando o access JWT está velho. `auth.json` é o mesmo inode em todos
  os panes da conta (`managed-accounts/codex/<acct>/home/auth.json` ou
  `~/.codex/auth.json`, linkado no overlay).
- `mcp-oauth-locks/file-store.lock` no overlay é lock do *MCP OAuth store*
  da CLI, um por CODEX_HOME privado. Não serializa o ChatGPT `auth.json`.
- Gate em `managed-auth-spawn-gate.ts` (chamado de `pty-ipc` antes do spawn):
  token fresco → todos passam; token velho → um leader spawna, os outros
  esperam o arquivo reescrito (lock `auth.json.nexus-spawn.lock`, timeout
  12s) e reusam o token. Sem git-lock no overlay.
- Mitigante de operador: contas Codex distintas em spawn paralelo evitam
  a família; o picker já tem uma linha por conta.

## Devin spawn: colagem depois do boot (ciclo 5)

- `spawn.initialPrompt` é `paste` (como Kimi). Posicional `-- <PROMPT>` nascia
  antes do trust e o pane morria com "agent pane did not start after prompt
  delivery".
- Trust interativo ("Do you trust the authors of this directory?") é
  `cliPromptAutoResponder` (`devin-workspace-trust`). `--respect-workspace-trust
  false` só existe no headless; extraArgs interativo continua vazio.
- Brief só depois do composer "Ask Devin to build". Auth: TOML em
  `~/.local/share/devin/credentials.toml`. `nexusMcp: none` permanece.

## Panes: quem abre, fecha (F-572)

- Um pane de agente custa ~0,5–1 GB (CLI + servidores MCP filhos). Em 16/09,
  33 spawns / 6 closes num orquestrador sem missão deixaram 22 panes parados
  e congelaram um Mac de 24 GB. Orquestrador/operador: ao ler o resultado de
  um helper, feche o pane (`nexus_pane_close`) ou nasça-o com
  `autoCloseOnHandoff: true`. Reabrir depois é `resume`, não custo perdido.
- O guardian fecha sozinho pane ocioso sem dono (worker sem missão, helper
  aberto pela mão do operador) após 30 min; nunca orquestrador, worker de
  missão, pane aberto pelo humano no renderer ou pane com `expect` armado.
- F-150: a elegibilidade mais ampla de estacionamento só vale sob pressão
  real, nunca como fallback do TTL. `isSessionIdleForCleanup` veta `working`
  mesmo antigo; receber um handoff (`isSessionInjectableIdle`) não é prova
  de que se pode encerrar o processo.
- `spawnAgentSession` NÃO trava o spawn: o gate de admissão AVISA (teto de
  panes 4–12 conforme a RAM, e memória disponível abaixo de 15 %) e a decisão
  de abrir é da mão do operador — doutrina "menos travas", decisão de 16/09.
  Trava dura só como opt-in explícito (`NEXUS_PANE_CAP_HARD=1`) ou
  `NEXUS_PANE_GUARD=off` para desligar tudo. **Swap em uso não é sinal de
  pressão**: no macOS ele guarda o pico, não o agora (medido: 8 GB de swap com
  o kernel em NORMAL), no Windows o campo do Electron é commit, e cada máquina
  tem a sua medida — lido como pressão, virou trava permanente até o reboot
  (0.76.44) e reaper em loop. O gate de swap só existe armado por máquina
  (`NEXUS_PANE_MAX_SWAP_MB`); não o ligue por default. Sob pressão real o
  guardian ESTACIONA um pane ocioso elegível por minuto sem esperar o TTL: o
  CLI é encerrado, o pane e o scrollback ficam, "Acordar" retoma a mesma
  conversa por resume. Ajuste por env (`NEXUS_PANE_CAP`,
  `NEXUS_PANE_MIN_FREE_MB`, `NEXUS_PANE_GUARD`). Não crie outro caminho de
  spawn que não passe por `spawnAgentSession`.
- Workers e orquestradores NÃO herdam o perfil MCP global do usuário
  (`~/.claude.json`); só a mão do operador (`role user`) herda. Quem precisa
  de um servidor MCP extra declara por allowlist.

## Terminais: geometria e retomada (F-356)

- F-356 (terminal): `fitHostGrid` mede com `proposeDimensions`, aplica o piso
  de colunas e só então faz um único resize. `fit.fit()` antes do clamp apaga
  texto no ciclo estreita→alarga. Enquanto `gridReady` for falso, saída antiga
  E nova ficam retidas; visibilidade sozinha não autoriza drenar o PTY.

## Velocidade de geração por LLM (tok/s + TTFT)

- Três medidores, três perguntas — não os confunda: `cost-tracker` diz QUANTO
  custou, `usage` (transcript) diz QUANTOS tokens o provider cobrou, e
  `token-speed` diz QUÃO RÁPIDO o modelo respondeu a rodada.
- O motor é PURO (`src/main/usage/token-speed-meter.ts`): o relógio entra por
  parâmetro em toda chamada, sem timer nem estado global. O plumbing (taps,
  escopo, throttle) fica em `src/main/orch/token-speed-tracker.ts`, particionado
  pela MESMA autoridade imutável do PTY que o cost-tracker usa.
- **Métrica ausente vai `null`, nunca 0.** Rodada curta demais, submit não
  observado ou zero token não sustentam um número; a UI imprime "—". Zero falso
  num medidor de velocidade é pior que métrica faltando.
- **Janela do tok/s depende da origem da contagem (23/09).** Estimativa pela
  tela: tokens vistos / tempo do 1º ao último texto visível. Contagem REAL do
  transcript: inclui pensamento e tool calls gerados no silêncio ANTES do 1º
  texto, então a janela vai do submit ao último token — dividi-la pela janela
  da tela dava 35 mil tok/s num pane parado. Real sem submit visto não tem
  janela honesta: `null`. A amostra expõe a janela usada em `rateWindowMs`
  (a UI mostra ela, não `generationMs`). Acima de
  `MAX_PLAUSIBLE_TOKENS_PER_SECOND` (6.000, guarda de sanidade acima de
  Cerebras/Groq) a taxa vira `null`. Tudo passa por `#rateFor`; não calcule
  tok/s em outro lugar.
- **Ao vivo é a rodada ABERTA.** `liveTokensPerSecond` = tokens até agora /
  tempo desde o 1º token (relógio `now`); quando o uso real já chegou na
  rodada, vale a regra acima (do submit). O chip/painel usam isso enquanto
  `streaming`; a última fechada só aparece em repouso. Sem 1º token (TTFT) o
  live fica `null` — não recicla o número da rodada anterior.
- **`flushIdle` NUNCA fecha rodada que ainda espera o 1º token.** O silêncio
  entre submit e 1º token É o TTFT, e passa dos segundos em qualquer modelo
  real — fechá-la destruiria a métrica principal. Só o próximo submit ou o fim
  do pane a encerram.
- A fronteira do silêncio mora em `#isSilent` e vale para os três usos (flush,
  corte de rodada obsoleta, indicador de streaming): intervalo de EXATAMENTE
  `idleCloseMs` já encerra. Teste com gap igual ao limiar parte a rodada em
  duas — calibre fixtures abaixo dele.
- A chave de agregação por LLM é o modelo REGISTRADO NA AMOSTRA, não o modelo
  atual do pane: quem troca de modelo no meio da sessão alimenta as duas linhas
  sem reescrever o passado. Pico do modelo é sobre todo o histórico retido, não
  sobre a janela recente — o teto observado de uma LLM não deve evaporar.
- `tapSessionInput` em `pty-manager` é observador read-only: não altera a
  escrita, e um tap que lança não derruba o terminal. Consumidores não podem
  persistir, logar nem encaminhar o payload. O prompt só fica em memória
  volátil até o 1º token, para separar eco de TUI de token do modelo — nenhum
  conteúdo entra no snapshot nem no IPC.
- Correção pelo transcript é idempotente por `sessionId:messageId`: o provider
  REESCREVE a mesma mensagem enquanto ela transmite, com total maior a cada
  reescrita, então a chave atualiza a MESMA amostra em vez de criar outra. O
  uso real pode chegar antes do timer de silêncio: fica pendente na rodada
  aberta e é aplicado no fechamento; não o descarte por ainda não haver
  amostra no histórico. Use o timestamp do transcript para casar a amostra
  temporalmente mais próxima — horário de chegada pode corrigir a rodada errada.
- O rascunho volátil usado para suprimir eco respeita a edição básica do
  terminal (Backspace/Delete, Ctrl+U, Ctrl+W e CRLF). Enter vazio ou só com
  espaços NÃO abre rodada; sem isso o repaint do prompt da CLI vira TTFT falso.
- Não classifique toda saída sem letra/dígito como ruído: respostas de código,
  pontuação e emoji são saída válida. O filtro de TUI remove somente famílias
  conhecidas de moldura/bloco/spinner; o piso de tokens cuida do ruído curto.

## Voz: STT

- **Grok Voice Transcribe 2.0 (xAI, provider `xai`)**: `POST api.x.ai/v1/stt`,
  `model=grok-voice-transcribe-2.0`, `language=pt`+`format=true`, `keyterm` =
  vocabulário CODE / wake word, `file` por último; chave `XAI_API_KEY` (mesma do
  Grok realtime). Só transcreve (`TRANSCRIPTION_ONLY_STT_PROVIDERS`). Migração
  insere o link após o último cloud da cadeia persistida, nunca no head;
  cadeias só-local não recebem.
- **Qualidade da fala antes do provider (F-638)**: `speech-quality.ts` mede
  cada ditado no mesmo PCM de 16 kHz que vai para a STT (fala em s, nível,
  fração 1–4 kHz) e grava `stt.audioQuality` no voice.log ANTES de
  transcrever. Abaixo de 4% de agudos com ≥ 1 s de fala o veredito é
  `muffled` e sai UM aviso por sessão ("Microfone chegando abafado"). Ditado
  que "erra tudo" num PC e acerta no Mac: leia `stt.audioQuality` antes de
  trocar de provider — em 23/09 era fone na entrada rosa, não o modelo.

## TypeSafe / Jev (skill `typesafe-ai`)

- Jev é um modelo de **julgamento tipado**, não de geração: `POST
  api.typesafe.ai/v1/systemone` recebe um `state` (texto/JSON) e perguntas
  `noul` (probabilidade de sim), `choice` (uma opção + distribuição +
  confiança) e `score` (níveis ordenados). Use quando um passo
  "prompt-e-parse" pode virar decisão estruturada (triagem, roteamento,
  ranking, verificação). Regra conhecida, cálculo e lookup ficam em código.
- Skill instalada globalmente em `~/.agents/skills/typesafe-ai` (`npx skills
  add typesafe-ai/skills --skill typesafe-ai -g`). O `skill-mirror` lê
  `~/.agents/skills` (`defaultSourceDirs`) e copia para cada CLI em panes
  diretos; em squads governados a skill só entra por `allowedSkills:
  ['typesafe-ai']`. Leia a SKILL.md e os docs vivos antes de integrar.
- Chave: `TYPESAFE_API_KEY` vive em `~/.config/typesafe/env` (modo 600),
  sourçado por `~/.zshenv`. Panes recebem só o `ENV_ALLOWLIST` de
  `pty-manager.ts`: a chave chega pelo shell do usuário, nunca pelo
  `process.env` do Main. Não a persista em settings, logs ou no repo.
- Terminal: `~/.local/bin/jev` (`jev --help`) lê o `state` do stdin, imprime
  JSON quando o stdout é pipe e sai com 0/1 (`--gate`), 2 (`--min-confidence`),
  3 (uso) ou 4 (API). Serve para triagem de saída de testes, gate semântico em
  diff e classificação de itens de QA.
- Todo `state` sai para um terceiro. Não envie segredos, tokens nem conteúdo
  de cliente sem consentimento. Integração no produto (Main/renderer) é egress
  de dados e passa pela revisão de `docs/SECURITY.md`. No produto já existe:
  chave em Ajustes → Chaves de API (cofre `jev-env:TYPESAFE_API_KEY`, fallback
  env); `src/main/jev/jev-client.ts` fail-open com `redactState`; revisão de
  evidência dos handoffs em `src/main/orch/jev-handoff-review.ts` (1 devolução,
  depois `[evidência fraca]` + artifact `nexus.jevReview`); tool `nexus_judge`
  (read-only, ALWAYS_ALLOWED, 30/min/sessão, state ≤ 32 KB); toggle
  `orch.jevAutopilot` / `NEXUS_JEV_AUTOPILOT=0`; skill `typesafe-ai` bundled e
  concedida aos roles `clean-code`.
- Sem chave: `nexus_judge`/`nexus_rank`/`nexus_tool_pick`/`nexus_browser_do`/
  `nexus_computer_do` somem do `tools/list` (`McpToolDef.available`) e a skill
  bundled não é espelhada (`bundledSkillFilter` no `skill-mirror`); nada mais
  muda — o cliente vê um Nexus 100% clássico.
- **Guarda de despacho** (`orch/jev-dispatch-guard.ts`, hook em
  `mcp-dispatch.ts`, surface `dispatchGuard`): toda chamada `nexus_*` COM
  efeito, dentro de missão e fora da mão do operador (a MÃO do operador nunca
  é julgada; FILHOS dela — pane com `operatorParentSessionId`, `role user`,
  sem missão — são julgados com o `prompt` do spawn (≤1500 chars,
  `operatorBrief` no token) como objetivo, em modo só-injeção: `deny` ≥ 0.8,
  nunca modal; sem `prompt` no spawn não há guarda), passa por três nouls — coerente com o objetivo da missão
  (`intentContract.goal`), argumentos com cara de instrução injetada,
  efeito irreversível. Política em código: injeção ≥ 0.8 → `deny` auditado
  com hint (o agente refaz com argumentos próprios); coerência ≤ 0.35 E
  destrutivo ≥ 0.6 → o modal de confirmação VOLTA mesmo em missão aprovada
  (exceção estreita à doutrina 09/09: é assinatura de sequestro, não
  cerimônia); tudo o mais → passa. Read-only e o conjunto isento
  (`GUARD_EXEMPT_TOOLS`: handoff_*, heartbeat, clarify, waits, reads, judge,
  rank, tool_pick, route_*) nunca são julgados. Args vão compactados
  (string > 300 chars vira `<N chars>`, JSON ≤ 2 KB, redigidos) e NUNCA
  entram no decision log. Cache de veredito por sessão+args por 60 s.
  Limiar 0.35 medido em 17/09 (`git push --force main` numa missão de login
  saiu coherent 0.33 / destructive 0.88); recalibrar pelo painel.
- **`nexus_tool_pick`** (`orch/tools-tool-pick.ts`, read-only,
  ALWAYS_ALLOWED): pré-filtro lexical (sinônimos pt-BR → inglês) sobre as
  ferramentas VISÍVEIS ao chamador (mesmo critério do tools/list), top 24,
  uma `choice` do Jev com `none`; devolve top-N com probabilidades e a
  margem 1º–2º — não corta por confiança (lição das rubricas: 24 opções
  derrubam a confiança por ambiguidade legítima). Registry injetado no boot
  (`setToolPickRegistry`). Medido: "ver o que outro pane está fazendo" →
  pane_read 0.84; "rodar os testes" → terminal_run 1.00.
- **`nexus_route_task` com Jev** (`orch/jev-task-routing.ts`, surface
  `taskRouting`): tier, especialidade e esforço julgados numa chamada, cada campo
  aceito só com confiança ≥ 0.6 (senão a heurística de palavras-chave, por
  campo); `tier` passado pelo chamador continua mandando na complexidade/modelo;
  o esforço é uma decisão independente sobre a tarefa, sem piso por especialidade.
  Pin humano/roster continua prevalecendo; esforço automático respeita a CLI;
  `specialtyOverride` é seam aditivo do `RouteContext` (política/benchmark/
  catálogo/reserva intocados). Resultado ganha `classifierSource`
  (`jev|heuristic|mixed`) e `escalate` (0..1) — informação para o Maestro,
  nunca decisão do router.
- `nexus_browser_do` ("Jev decide, Nexus executa"): UMA confirmação humana
  por objetivo; ação irreversível/custosa sempre para em `needs_confirmation`
  e devolve a proposta; trava de origem (`left_origin`); textos digitados são
  só os `values` fornecidos (Jev escolhe o label); cap de passos
  (`maxSteps ≤ 40`); uma entrada no decision log por passo.
- **Browser do agente**: toda ação devolve `after`/`changed` (Main, cobre
  navegação entre documentos); `read: true` embute a página; `nexus_browser_find`
  e `click/fill` por `text` (nome acessível, nunca CSS; ambíguo devolve
  candidatos; Jev desempata só com 2–5 candidatos e confiança ≥ 0.7);
  `viewport`/`atBottom`; `format: 'compact'` no read. Cada ação e o read
  devolvem `errors` (console/HTTP ≥ 400/falha de carga desde a ação anterior)
  e o read traz `alerts` da página (role=alert, aria-invalid, allowlist de
  classes de erro — árvores sensíveis excluídas). `judge: true` anexa um
  julgamento Jev da página (erro visível, bloqueio humano, carregando, tipo de
  página; fail-open com `judgmentSkipped`). `nexus_browser_extract` extrai
  campos tipados: o código levanta candidatos (JSON-LD, tabelas, label→valor,
  tokens) e o Jev só escolhe entre eles — `null` quando nada confiável;
  extract usa UMA chamada Jev para todos os campos (fan-out); booleano
  indeciso (0,4–0,6) vira null.
- **Skill suggestion** (`jev-skill-suggestion.ts`, surface `taskRouting`):
  uma `choice` entre as skills bundled (+`none`) para a tarefa;
  `nexus_route_task` devolve `skillSuggestion`, o auto-route do `pane_spawn`
  acrescenta uma linha ao prompt do filho só com confiança ≥ 0.7 e skill
  permitida. Cookbook oficial 'skill suggestion'.
- `nexus_computer_do` (macOS, "Jev decide, Nexus executa no desktop"):
  exige permissão de Acessibilidade (`permission_required` aponta o caminho
  dos Ajustes); só a mão do operador ou o orquestrador chamam — worker nunca
  dirige o desktop; trava de app (`focus_lost`); lê a árvore AX do app e, se
  ela vier pobre, OCR local da janela (pixels nunca saem da máquina — ao Jev
  vão só rótulos de elementos e labels de `values`); campos sensíveis
  (`AXSecureTextField`, password/senha) nunca têm valor lido nem recebem
  texto; irreversível sempre para em `needs_confirmation` (best-effort: uma
  captura da janela em `userData/jev/computer/<runId>/confirm.png`, só nesse
  caminho); detector de travamento (3 passos iguais); cap de passos; log por
  passo (surface `computerTool`).
- **Fan-out do operador sem missão** (`tools-panes.ts`): filho ad-hoc herda
  o allowlist do operador (`attenuateTools(ctx.allowedTools, null)`) em
  Autopilot — em Hardened continua `[]`. Filho do operador sempre recebe
  `--strict-mcp-config` (Claude) / `preserveUserMcp: false` (Codex): F-572,
  um helper nunca carrega o perfil MCP global. `nexus_pane_spawn` sem
  `adapterId` na mão do operador roteia `task ?? prompt` pelo mesmo motor do
  `nexus_route_task` (Jev tier/especialidade + tabela) — receipt
  `harness.source: 'auto-route'` + `route`. **Não despachar N helpers no
  mesmo adapter** (três Sonnet, três Claude) só porque o Codex está
  indisponível: misturar CLIs vivas (Codex/Claude/Grok/Kimi/AGY/GLM). O
  título OSC da tarefa não é a identidade do pane (F-597).
- **Handoff sem missão** passa pela mesma revisão Jev do handoff de missão
  (`reviewMissionHandoff`): 1 devolução, depois `[evidência fraca]` no resumo
  que chega ao pane pai + artifact `nexus.jevReview`. Continua correspondência
  `unverified`.
- **Triagem de Bash nativo** (Claude): hook `PostToolUseFailure` com matcher
  `Bash` → `POST /hook/triage` (mesmo bearer do gate) → `triageCommandFailure`
  → `hookSpecificOutput.additionalContext` de volta ao agente. O hook nunca
  bloqueia (`-sf … || true`, `{}` quando a superfície está off).
- **Consumo do Jev** (`jev-decision-log.ts`): além das decisões, o diário
  grava consultas SEM resposta (`kind: 'no-answer'`, motivo categórico,
  nunca texto) — `judge()` registra centralmente quando o chamador informa
  `surface`. O painel Decisões do Jev mostra Hoje/30 dias/desde sempre
  (consultas · custo estimado · sem resposta) e, por superfície,
  `pelo Jev · pela regra`; custo = tokens de entrada × US$ 0,042/M (preço
  público TypeSafe, chamada direta, sem OpenRouter).

## Xiaomi MiMo Code (F-627)

- Adapter `mimo-code`, binário oficial `mimo` (`@mimo-ai/cli`), não OpenCode
  nem Claude. `--trust` pertence à TUI, nunca a `mimo run` headless.
- Auth oficial: XDG `mimocode/auth.json`, ou `$MIMOCODE_HOME/data/auth.json`;
  preservar somente `xiaomi` nas contas gerenciadas. UID + endpoint identifica
  o perfil: API e Token Plan da mesma pessoa não devem se sobrescrever.
  A configuração inline precisa fixar chave por referência de ENV e endpoint
  da conta selecionada: opções nativas `provider.xiaomi.options` prevalecem
  sobre auth.json na CLI e poderiam faturar outra conta.
- Desktop Membership NÃO é Token Plan. Token Plan usa endpoint regional e
  inclui V2.6 Pro/Flash; UltraSpeed exige API pay-as-you-go separada. Não
  reutilizar cache genérico de login para elegibilidade de modelo. Benchmarks
  automáticos exigem chave `sk-`, nunca o plano `tp-` de ferramentas interativas.
- O catálogo remoto da CLI pode atrasar: projetar `MIMO_CLI_MODELS` no inline
  config de panes/benchmarks; não inventar limites, esforços ou resultados.
  Modelos sem medição devem aparecer como não avaliados na comparação.
- Conversas ficam no provider-state do checkout, não no DB nativo. Hook privado
  usa porta/bearer e nonce por spawn em ENV; Main valida raiz/cwd/conta antes
  de aceitar sessionID. Retomada usa ID exato, jamais a última conversa alheia.
  Login nativo sem accountId recebe owner opaco por UID/endpoint (hash da key
  se UID ausente), validado antes do argv e na cópia para outro pane. O ledger
  por sessão preserva esse dono mesmo após `/new`; não usar só a última sessão
  do pane como prova de propriedade.
- Cota Token Plan é outra autorização: janela explícita do console em sessão
  Electron própria; compara userId ao UID da CLI antes/depois da consulta.
  Consentimento persistido contém apenas hashes. Sem cookies autorizados,
  cota fica indisponível; isso não prova logout da CLI. Não extrair cookies
  de navegadores externos nem tratar expiração do plano como reset da quota.
- Tokens do SQLite: input exclui cache; output exclui reasoning (somar uma vez).
  Reescrita da mensagem atualiza uma linha. Custo reportado pela CLI é estimativa,
  não fatura do Token Plan. Nenhum texto de prompt entra na telemetria.

## Helpers do operador sem missão (F-156/F-157)

- O handoff de workspace só fecha um helper armado após `markSubmitted` confirmar
  a entrega ao pai e somente com status `success`. Se a entrega ficou `queued`,
  o pane permanece vivo para retry. O braço de auto-close é consumido pelo mesmo
  helper usado no handoff de missão; o fechamento roda após a resposta MCP.
- A rota automática desse spawn exige `canUseNexusMcp(adapter)`: sem missão não
  há shim de nx-mail. Se a tabela/Jev escolher AGY, Aider, Devin ou Muse, o
  resolver exclui essa CLI, tenta a próxima e expõe o descarte no recibo.
- Primeiro uso do AGY pode mostrar esquema de cores e Termos antes do composer.
  Consentimento sobre Termos cabe ao operador; nunca marcar aceite por ele.
