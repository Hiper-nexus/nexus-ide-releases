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
- F-162 (26/09): novas abas (+, Montar meus terminais e wizard) têm worktree
  durável fora da raiz, criada de HEAD sem copiar WIP. Abas/missões legadas
  não migram. `workspaceBinding` Main-owned entra no hash da review; a adoção
  conserva a pasta do pane escolhido. `mission-execution-scope.ts` resolve
  a pasta física; bancos/eventos/hub MCP continuam no scope de coordenação.
  Retomada não recria worktree perdida; fechar aba não remove WIP/branch.
- Primeira onda, retomada, sensores mecânicos, revisão, artefatos e push usam
  a execução da missão. Mtime do checkout novo não prova entrega: use o
  SHA-base da aba. PREVC mutável/sensores congelados e `isolatedWriter` ainda
  são recusados explicitamente na aba; jamais caia em main. Estado e limites
  em `docs/analysis/2026-09-23-abas-feature-worktree.md`. Não crie worktree
  dentro da raiz do projeto.
- F-654: o Git para Windows recusa `git worktree add` com `<worktree>\.git`
  acima de 220 caracteres (`'$GIT_DIR' too big`; `core.longpaths` não ajuda),
  e o runtime do checkout em `%APPDATA%` já tem ~219. Por isso, no win32,
  worktrees e candidatos de merge moram em `<project-runtime>\wt` e `\mc` com
  nomes compactos. Todo caminho físico de worktree sai de
  `managed-worktree-layout.ts` (criação, validação, recuperação, fila de
  merge); macOS/Linux mantêm o layout histórico byte a byte. Não monte esse
  caminho à mão em outro lugar.

## Várias missões pelo "+ Pane" (F-198/F-373/F-374)

- Maestro vivo e ocioso é missão viva. `projectMissionEngineSnapshotView`
  conta a sessão `idle` do líder provado em `orchestratorLive` e marca
  `orchestratorIdle`; sem pane `working|waiting|blocked`, `projectState`
  projeta `running` com o motivo `awaiting-instruction` (rail e abas:
  "Aguardando"; Quadro: "Aguardando sua instrução", com a orientação liberada).
  "Dormindo" fica para missão sem processo. Não volte a exigir `busy|spawning`
  para liveness: o Maestro parado no prompt é o estado normal da missão da aba,
  logo depois de "Tornar orquestrador" e entre um pedido e outro.
- "Tornar orquestrador" só entra na missão da aba que tem
  `hasCurrentDispatchAuthority`, a mesma régua do Main. Entre várias vivas, a
  da aba é a de `workspaceBinding.tabKey` igual à chave da aba. Missão
  dormindo, parada pelo operador ou esperando resposta continua listada, mas o
  pane novo abre outra missão em vez de receber `mission_unavailable`.
- Aba cuja missão está Dormindo/Parou (`session-sleeping`/`runtime-closed`)
  volta a oferecer "Criar missão desta aba" e fecha pelo ×; `session-dead`
  (row `running` sem runtime) ainda segura a aba. "Criar missão desta aba" só
  coroa pane com sessão viva (`pickTabMissionLeader`).
- Com o líder da missão da aba VIVO em outro pane, "Tornar orquestrador"
  pergunta: "Nova missão deste painel" (`createPaneMission` com
  `ownGroup: true`: missão separada, sem `tabKey`) ou "Assumir a liderança" (a
  troca de coroa). Missão nova com nome já usado ganha sufixo " 2", " 3"…
  dentro do teto de 120 caracteres do Main.

## Portão de regressão: config do runner e falha de carga (F-199)

- Projeto sem config do Jest/Vitest na raiz do pacote costuma declará-la em
  cada script (`jest --config tests/jest.config.js`). `detectRegressionRunner`
  lê esse `--config`/`-c` dos scripts do próprio runner (arquivo real dentro
  da raiz) e o portão o repassa. Sem isso o `ts-jest` não carrega e todo teste
  TypeScript "quebra" — foi o que recusou todos os writers do saasbarbearia.
- Suíte que nem carrega ("Test suite failed to run" com erro de parse) não é
  regressão por si: só barra quando o arquivo acusado está no diff ou o diff
  tocou config de runner/transform. Acusado fora do diff vira "não
  verificado"; acusado que não dá para extrair continua barrando. Os caminhos
  das worktrees isoladas no macOS têm espaço (`Application Support`): a
  extração do caminho precisa aceitar espaço.

## Orquestração automática e modelo por tarefa (F-200/F-214)

- Todo pedido digitado num pane do "+ Pane" passa pelo Jev de delegação
  (`/hook/delegate`). Com `divisible ≥ 0,6` e 2+ partes o agente recebe a
  dica; com `≥ 0,7` em Autopilot o Nexus adota o pane pela missão sob demanda
  da aba (`adoptThroughOperatorTabMission`, o mesmo provedor do 1º helper) e
  a dica vira diretiva de abrir os helpers. Hardened só dá a dica. O critério
  `divisible` conta "a mesma mudança em apps/superfícies separadas" (nativo e
  web/PWA): foi o que faltou no pedido real de 29/09 (0,52 → 0,84 na
  avaliação com o Jev). Mude a régua só com avaliação em pedidos reais.
- O hook não julga o que não foi o operador que escreveu: `<task-notification>`,
  entrega de handoff (mesmo dentro de `<pasted_content>`), "Stop hook
  feedback", corpo de skill, avisos `[Nexus]` e o pack de failover voltam `{}`.
- Variante por tier na `DEFAULT_ROUTING_TABLE`: Flash/mini/Luna/Haiku no
  rotineiro, Pro/Sol/Opus no hard. Revisão em hard/critical e todo o critical
  levam o topo (`FRONTIER_ORDER`) à frente de qualquer CLI depois do
  multi-score; hard sem revisão segue distribuindo entre todas as LLMs.
  DeepSWE, TB2.1 e SWE-bench Verified saturaram: modelo barato empata com o
  topo neles, e só o TB4 os separa.
- F-700: o GPT-6 Astra é caso raro (regra do operador, 30/09). Não está em
  nenhuma tabela nem na `FRONTIER_ORDER`; entra só pelo nome ("com o GPT-6
  Astra", `mentionedRoute`) ou por escolha do operador. Com o Maestro Claude,
  `reserveClaude` tira Opus/Fable dos workers, e com o Astra no topo ele virou
  1 de cada 4 workers num dia. Não o devolva à rota automática; a regra do
  "mais novo da linha" também não o traz (`gpt-6.1-astra` continua fora).
- F-701: o Maestro recebe a doutrina de delegar em três lugares. O kickoff,
  as `instructions` do MCP (`MAESTRO_STANDING_DOCTRINE` via
  `maestroStandingContext`: prompt de sistema, sobrevive à compactação) e o
  hook do prompt (`MAESTRO_TURN_REMINDER` a cada 30 min, inclusive na entrega
  de um worker; o Codex recebe a doutrina inteira). Execução direta e
  pergunta aos panes não recebem: a doutrina delas diz o contrário. F-708:
  pedido digitado pelo operador no Maestro passa pelo Jev de delegação e, com
  2+ partes, vira "abra N workers" no lugar do lembrete.
- F-702: worker nunca pergunta ao humano (`request_user_input_async` do
  Codex, AskUserQuestion): ninguém responde e o pane trava. Brief que
  contraria a autoridade de execução (clone próprio, push, outra branch)
  perde para o Nexus e volta como bloqueio no handoff. `features.multi_agent`
  e `default_mode_request_user_input` do Codex não removem a ferramenta; a
  regra vive no contrato (`withHandoffContract`).
- Modelo mais novo sempre (regra do operador, F-691/F-217/F-218): dentro de
  uma linha (`modelLineOf` em `src/shared/model-line.ts`: só os números
  mudam), a versão mais nova que a CLI oferece substitui a velha na rota, no
  padrão do pane, no `model` explícito do `nexus_pane_spawn`, no template de
  squad e no modelo citado no texto. Sem benchmark, herda a nota da versão
  anterior; versão nova de modelo de topo continua topo. Não sobem: roster
  selado, reserva de rota já emitida, resume e o "+ Pane" do renderer.

## Worktree rápida e tamanho do PTY (F-215/F-216)

- A worktree de writer isolado, a da aba nova e o candidato de merge clonam
  o `node_modules` com `clonefile(2)` no diretório inteiro, via
  `/usr/bin/osascript -l JavaScript` (script constante, caminhos só como
  argv). `cp -cR` copia entrada por entrada: 32 s contra ~4-6 s num
  node_modules de 331 mil entradas. Symlink, falha ou
  `NEXUS_COW_DIRECTORY_CLONE=0` voltam ao `cp -cR`. `node_modules` aninhado
  (profundidade 1-2, ao lado de `package.json`) só entra se o git o ignora:
  sem isso a worktree nasceria suja.
- O renderer reafirma o tamanho do PTY no foco e na volta de visibilidade
  (`resize` com `assert`); winsize igual não gera SIGWINCH. O Main grava
  `pty-grid-drift` quando o PTY estava em outro tamanho e
  `pty-resize-dropped` quando descarta resize de sessão de outro dono. Os
  panes Claude/GLM do operador usam o renderizador fullscreen
  (`"tui": "fullscreen"`), em que todo resize redesenha a tela inteira.

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
- Adapter `muse`: CLI própria (`bin: muse`, `mcpAutoload: false`,
  `nexusMcp: muse`). `spawn.extraArgs` inclui `--trust-workspace`. F-696: o
  Muse Code 1.4+ lê `mcpServers` do `settings.json` (`$XDG_CONFIG_HOME/muse`,
  padrão `~/.config/muse`) e herda o ambiente nos servidores stdio; o Nexus
  registra UMA vez `mcpServers.nexus` → a mesma ponte stdio do MiniMax, com
  URL/bearer só por ENV. `bearer_token_env_var` e `${VAR}` em `headers` não
  funcionam no 1.4.1 (testado com `muse exec`). Muse < 1.4 não tem o arquivo
  tocado; o handoff cai no fallback PTY/nx-mail.
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
  `~/.local/share/devin/credentials.toml`.
- F-698: o Devin TEM o MCP do Nexus (`nexusMcp: devin`).
  `ensureDevinNexusMcpRegistration` registra `nexus` → a ponte stdio do F-678
  pela própria CLI, sempre `devin mcp add --scope user` (o escopo padrão é
  `local`, dentro do repositório — nunca grave lá), idempotente via
  `devin mcp list`. URL/bearer só por ENV, que o Devin repassa ao stdio
  (provado com `devin -p` no 3000.11.1). Registro falho em worker de missão
  derruba o spawn. Orquestrador declarado (coroável à mão), não verificado.

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
- **Nomes canônicos no viés do ditado (F-657)**: `shared/dictation-vocabulary`
  exporta `DICTATION_CANONICAL_NAMES` (Jev, Nexus, Claude…) e
  `DICTATION_ENGINE_VOCABULARY` (código + nomes) — é ESTA lista que viaja como
  `keyterm` do xAI, `custom_vocabulary` do Gemini e priming do Whisper, e a
  reescrita do CODE (`code-prompt-polish`) só restaura grafia canônica desses
  nomes; Java real, caminhos, flags e IDs ficam como reconhecidos, e soletração
  ou autocorreção do falante vencem. Ditado é dado, nunca instrução ao modelo.
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
  depois `[evidência fraca]` + artifact `nexus.jevReview`; F-707: só devolve
  resumo genérico e código mudado sem verificação ou sem dizer onde — achado
  de revisor e pendência admitida entram marcados; rubrica medida com o Jev
  real nas 105 entregas do HiperGO, reavalie no mesmo conjunto se mudar o
  texto); tool `nexus_judge`
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
  rank, tool_pick, route_*, pane_close — F-709) nunca são julgados. Args vão compactados
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
  `taskRouting`): tier, especialidade, esforço e sugestão de skill julgados no
  mesmo lote (skill só quando há catálogo permitido), cada campo
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
  uma `choice` entre as skills bundled permitidas (+`none`) para a tarefa,
  incluída na chamada de classificação do `nexus_route_task`;
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
- **Memória do projeto pelo Jev** (F-703): as linhas automáticas nascem de
  cinco trilhos. O aceite de tarefa do plano selado, o ACK físico do Maestro à
  entrega avulsa (`nexus_handoff_ack` → `#retainAcknowledgedHandoffMemory`),
  o fim de sessão com evidência verificada, o merge aprovado e a preferência
  digitada no "+ Pane". Na missão da aba só o ACK roda: sem ele, dois dias de
  HiperGO deram zero memórias. Texto de agente só entra destilado pelo Jev
  (sem diretiva, vale lembrar); descartado não grava. A memória é local da
  máquina (`userData/agent-memory`): o Mac e o Windows não compartilham.
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

## MiniMax Code (F-655)

- Adapter `minimax-code`, binário oficial `mcode` (`@minimax-ai/code`), não o
  Claude no endpoint da MiniMax — essa rota continua sendo o upstream
  `minimax` do launcher (`api.minimax.io/anthropic`, `MiniMax-M3[1m]`).
- Instalação exige os scripts nativos: `--allow-scripts=@minimax-ai/code,better-sqlite3`
  (o npm 12 bloqueia por padrão e o SQLite da CLI quebra). Atualização é
  `mcode update`, nunca o `npm install -g --prefix` genérico, que perde as flags.
- Login: `mcode login --region global` (China: `--region cn`) ou chave própria
  da CLI (`mcode provider set-minimax-key`). A prova de sessão lê só
  `~/.minimax/auth/prod/<en|cn>/mcode-public/auth-state.json` (status público,
  sem token) ou a linha `minimaxModelSource: minimax_api_key` do `config.yaml`.
  Nunca ler `auth.json` (access/refresh). Sem multi-conta: uma sessão nativa.
- F-678: o pane PTY TEM o MCP do Nexus (`nexusMcp: minimax-code`). A TUI e
  o `exec` leem servidores de `<dataDir>/mcp.json` ("User-configured"), do
  `.mcp.json` do projeto e de plugins locais — o `config.yaml` não declara
  MCP. O Nexus registra UMA vez `mcpServers.nexus` (stdio → ponte
  `~/.nexus/mcp-bridge/nexus-mcp-bridge.cjs`) em `~/.minimax/mcp.json`, por
  mescla idempotente; URL e bearer da sessão chegam só por ENV
  (`NEXUS_MCP_URL`/`NEXUS_MCP_TOKEN`, que o stdio herda). Sem ENV a ponte
  responde zero ferramentas. Nunca use `MINIMAX_DATA_DIR` como overlay: a
  credencial é chaveada pelo caminho do data dir e o login some. O harness ACP
  (`mcode acp`) continua recebendo `mcpServers` no `session/new`.
- A TUI não tem flag nem ENV de permissão nem de esforço: vêm do `config.yaml`
  (`permissionMode`, `defaultModelThinking.effort`); `MCODE_CONFIG_DIR` é só das
  ferramentas de sandbox. F-692: todo pane MiniMax gravável roda livre como as
  outras CLIs — `ensureMinimaxFullAccess` grava `permissionMode:
  bypassPermissions` no `~/.minimax/config.yaml` antes do spawn (edição textual
  da linha de topo, idempotente). Lane somente leitura não é liberada. O Jev
  roteia sem `effort`.
- Prompt inicial posicional depois de `--` (commander lê `-x` como opção).
  Resume só por id exato (`--session <id>`); sem hooks não há id capturado,
  então `--continue` (última sessão do cwd) fica proibido.
- Cota Token Plan: `GET /v1/token_plan/remains` com a Subscription Key (a mesma
  chave do upstream `minimax`, cofre/launcher, ou `MINIMAX_API_KEY`). Região
  preferida = região do `mcode login`; chave recusada tenta a outra uma vez.
  `*_usage_count` é o RESTANTE (igual ao cliente oficial). Nunca usar o
  endpoint privado `coding_plan/remains` nem os headers assinados do cliente.
- Benchmark headless: `mcode exec --output-format text --model {{MODEL}} -- {{PROMPT}}`,
  sem `--permission` (padrão smart). Modelos entram NÃO avaliados.

## Helpers do operador sem missão (F-156/F-157)

- O handoff de workspace só fecha um helper armado após `markSubmitted` confirmar
  a entrega ao pai e somente com status `success`. Se a entrega ficou `queued`,
  o pane permanece vivo para retry. O braço de auto-close é consumido pelo mesmo
  helper usado no handoff de missão; o fechamento roda após a resposta MCP.
- A rota automática desse spawn exige `canUseNexusMcp(adapter)`: sem missão não
  há shim de nx-mail. Se a tabela/Jev escolher uma CLI sem MCP do Nexus, o
  resolver exclui essa CLI, tenta a próxima e expõe o descarte no recibo.
- F-697: o AGY TEM o MCP do Nexus (`nexusMcp: agy`). Ele ignora a projeção de
  HOME privado, mas lê o perfil nativo: `ensureAgyNexusMcpRegistration`
  registra `nexus` → a ponte stdio do F-678 pela própria CLI (`agy mcp add`,
  idempotente via `agy mcp list`, memorizado por processo); URL/bearer só por
  ENV, que o AGY repassa ao stdio (provado com `agy -p` no 1.2.14). Registro
  falho num worker de missão derruba o spawn — nunca um worker esperando um
  handoff que não pode entregar. Fora do Nexus a ponte fica muda.
- F-219: teste que chama `prepareAgentSpawnDecoration` para AGY, Devin ou Muse
  mocka `ensureAgyNexusMcpRegistration`, `ensureDevinNexusMcpRegistration` e
  `prepareMuseMcpSession` (modelo em `mcp-server-governed-profile.test.ts`).
  Sem o mock a suíte roda o `agy mcp add` de verdade e grava o `nexus` no
  perfil real de quem roda os testes (Mac, 30/09).
- F-658: a missão leve da aba (0.76.110) leva os helpers seguintes do "+ Pane"
  à rota de MISSÃO. Ali o pane promovido (`promotedFromUserSession`) mantém a
  mesma regra: `excludeAdapterIds` com as CLIs sem MCP, numa chamada só (sem
  reserva órfã). O uso da missão soma os panes vivos da missão que ainda não
  têm linha em `mission_panes` (`liveMissionAdapterIds`) — sem isso a
  diversidade do rerank não via os irmãos e três helpers caíram no mesmo AGY,
  mudo no `--print` até terminar. Rota nova de spawn: repasse as duas coisas.
- Primeiro uso do AGY pode mostrar esquema de cores e Termos antes do composer.
  Consentimento sobre Termos cabe ao operador; nunca marcar aceite por ele.
- F-662: a regra "helper só em CLI com MCP do Nexus" vale para a MISSÃO da
  aba (`isOperatorTabMission`), não para quem pergunta: o orquestrador retomado
  não é `promotedFromUserSession` e o `nexus_route_task` direto não passava
  pelo auto-route do spawn. Pane one-shot (`OwnedAgentSessionInfo.oneShot`,
  AGY `--print`/OpenCode `run`) não lê o terminal: `nexus_pane_ask` responde
  `state: 'oneshot'` sem digitar nada e `nexus_pane_write` avisa no recibo.
- Codex no Windows ≥ 0.157 lança `codex-code-mode-host.exe` a partir do
  próprio pacote npm. No prefixo do Node do WinGet o caminho passa de 260
  caracteres e toda ferramenta do Codex falha com `failed to spawn code-mode
  host … (os error 3)` — dentro e fora do Nexus (o `logs_2.sqlite` do
  provider-state mostra). Não é bug do pane: instale o Codex num prefixo curto
  (`npm i -g --prefix %USERPROFILE%\.local\bin @openai/codex`).

## Windows: o encerramento do PTY precisa se provar (F-659/F-660/F-661)

- O `node-pty` do Windows lança `Signals not supported on windows` para
  QUALQUER `kill(sinal)`. Toda morte de raiz de PTY passa por `killPtyRoot`
  (`pty-descendant-termination.ts`): sem sinal no win32, com sinal em POSIX.
  Chamar `proc.kill('SIGTERM')` direto deixa a sessão presa no voo de
  encerramento — entrada recusada, saída descartada, "Retomar"/"Pedir ajuste"
  esperando para sempre, e o reconciliador de 1 s repete a tentativa.
- Pane `idle` não é "orquestrador terminou". Maestro parado numa pergunta ao
  operador (hook `awaiting-input` ou notificação, rodada ainda aberta) é
  `isAgentAwaitingOperator` e conta como ocupado no `orchestratorBusy` da
  entrega civil e do "pronto". Só o `Stop`/erro do hook fecha a rodada.
- Missão da aba (sem `squadId`, com `workspaceBinding.adoptedPaneId`) retoma a
  CONVERSA de quem a liderava: `operatorTabMissionResumeSpec` escolhe o último
  orquestrador da composição e o respawn usa `resume: true` +
  `resumeFromPaneId` com a CLI, o modelo e a conta desse pane. Não volte a
  subir o Maestro do squad padrão para ela: vira um Claude vazio.

## Remoção recursiva nunca segue link (F-663)

- O `fs.rm`/`fs.rmSync` recursivo do Node 24 (Electron 43) ATRAVESSA junctions
  no Windows e apaga o conteúdo do alvo. O Node 22 do terminal e do vitest não
  faz isso — teste que só confere "o alvo sobreviveu" passa no código errado.
- Overlays de pane ligam por junction as conversas do provider-state, perfis
  de CLI e a identidade do operador. Toda remoção recursiva no Main usa
  `removeTreeSync`/`removeTree` (`src/main/util/remove-tree.ts`): tira cada
  link da árvore primeiro e só então apaga o resto. Não chame `fs.rmSync(…,
  { recursive: true })` direto em código novo.
- Para provar um caso real no runtime do app:
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe script.js`.
- F-664: a retomada da missão da aba move a linha do orquestrador para o pane
  novo (`moveOrchestratorPane`) — `missionPanes.record` deduplica pela
  identidade e nunca troca `pane_id`.
- F-665: "Pedir um ajuste" deixa `<!-- nexus:awaiting-adjustment:<ts> -->`
  até a missão pedir conclusão. Na retomada da conversa da aba só o ajuste
  dos últimos 5 min (`operatorTabResumeAwaitsAdjustment`) prepende "AGUARDE O
  OPERADOR"; senão a nota manda resumir onde parou e continuar. O hold do
  Pronto continua lendo o marcador inteiro.
- F-666: o Codex 0.157 abre "Folder access" (Open restricted / Quit) para
  pasta `trust_level = "untrusted"` — o perfil governado marca a worktree assim.
  A assinatura `codex-folder-access-restricted` responde "Open restricted"
  lendo a tela; nunca "Trust and continue". No Windows o perfil governado liga
  `features.code_mode_host` (`codexGovernedCodeModeHost`): o Codex instalado
  roda toda ferramenta por ele. O macOS governa o binário fixado e mantém off.
- F-668: nunca entregue argv a um `.cmd` do npm no Windows — o `cmd.exe` corta
  o argumento na 1ª quebra de linha (o brief chegava como "## Nexus execution
  authority"), expande `%VAR%` e limita a 8K. O spawn direto usa
  `windowsNpmShimSpawn` (pacote verificado → `.exe` ou `node.exe` + script,
  `node` ao lado do atalho ou do PATH) para toda CLI embutida.
- F-669: no Windows a linha de comando inteira tem 32.767 caracteres; brief
  acima de `WINDOWS_NATIVE_PROMPT_MAX_CHARS` (20K) não vai no argv —
  `nativeArgvPromptFits` decide no pty-manager, no tool-util e na Via Rápida,
  que colam o brief depois do boot.
- F-672: escolha explícita de CLI no `nexus_pane_spawn` é respeitada, mas o
  recibo traz `diversity` quando a CLI já tem 2+ helpers vivos na missão
  (`sameAdapterDiversityHint`): omitir `adapterId`/`model` devolve a rota ao Jev.
- F-670/F-671: a decisão final do brief no argv do Windows é do pty-manager,
  que conhece executável e argv finais: `.cmd`/`.bat` ou linha acima de 32.000
  (`windowsArgvPromptPlacement`, aspas do MSVCRT) tiram o brief do argv e o
  gancho `setDeferredInitialPromptHook` (mcp-server → `deliverAgentPrompt`) cola
  depois do boot. Canal one-shot recusa com erro claro.
- F-673: no Windows o xterm nasce com `windowsPty: { backend: 'conpty', buildNumber }`
  (`xtermWindowsPty`, build via `window.nexus.windowsBuild`). Sem isso ele puxa o
  histórico ao ganhar linhas enquanto o ConPTY repinta: texto sobreposto.
- F-674: na missão da aba, `adapterId` fixado pelo orquestrador numa CLI com 2+
  helpers vivos é redistribuído (`route.redistributed`); `operatorChoice: true`
  preserva a CLI que o operador pediu.

## Rotação de contas e roteamento com dados públicos (F-675/F-676/F-677)

- F-675: sem avaliação `nexus-eval`, a qualidade do candidato no
  `route-pipeline` vem de `orch/published-benchmarks.ts` — números OFICIAIS
  do fabricante (DeepSWE v1.1, Terminal-Bench 2.1, SWE-bench Verified), cada
  um com URL da fonte. Terminal-Bench de outra versão não entra (não é
  comparável). Variante só herda (`sameModelAs`) quando o fabricante diz que é
  o mesmo modelo; sem número publicado não há nota. Linha nova na tabela de
  rota precisa de nota ou de entrada em `UNPUBLISHED_ROUTE_MODELS` no teste.
- F-189 (uso geral): no `scoreRouteCandidate` a nota de qualidade pesa em
  dobro e modelo sem benchmark publicado recebe `NEUTRAL_UNPUBLISHED_QUALITY`
  (15), nunca o piso; a posição na tabela é só desempate e a distância de tier
  pesa −10 por degrau. A heurística de especialidade não prefere provider
  (`HEURISTIC_SPECIALTY_ADAPTERS` vazio; só o piso de esforço). No
  `nexus_route_task`, `preferAdapters` é bônus leve e `exclude` do chamador só
  vale para CLI doente (circuito aberto, contas em cooldown, worker morto na
  missão) — exclusão de CLI saudável é ignorada e aparece no `reason`.
- F-676: frota de 10–100 contas. O disjuntor de morte instantânea é POR CONTA
  (2 mortes da mesma), e o provider só trava com 5 contas distintas mortas na
  janela. `performSwitch` percorre até 12 contas (`excludeIds` no
  `pickAvailableForFailover`) e tira a que não prepara da frente por 5 min.
  Sondagem de cota: no máximo `QUOTA_PROBE_CONCURRENCY` (6) contas em voo; a
  confirmação de limite usa `refreshForLimitHit(hitAt)`, que divide só a
  leitura forçada que saiu DEPOIS do hit — leitura anterior nunca refuta.
- F-677: o AGY 1.2 do Windows autentica pela vaga ÚNICA `gemini:antigravity`
  do Gerenciador de Credenciais; HOME/USERPROFILE/GEMINI_CLI_HOME isolados e
  `*_APP_DATA_DIR` não mudam a vaga, e o refresh passa pelo servidor do Google
  (ADC por pane não serve). `captureNativeAuth('agy')` lê a vaga quando não há
  arquivo; `prepareProviderSpawnAuthoritative` grava a conta escolhida na vaga
  (`activateAgyAccountForSpawn`): guarda antes a sessão que estava lá
  (`preserveAgyKeyringSession`, nunca mexe em cooldown/ativa), grava, relê a
  identidade e, entre contas diferentes, espera `AGY_KEYRING_SETTLE_MS` para o
  AGY recém-aberto ler a vaga. Pane sem conta fixada nasce na dona da vaga
  (`agyKeyringSlotAccount`) ou, se ela esgotou, na irmã da regra de folga. O
  segredo viaja por stdin em base64; teste nunca toca a vaga real (só com
  `exec` injetado). Conta AGY por chave de API não passa pela vaga.

## Jev enxugando a orquestração (F-194/F-195/F-196/F-197)

- F-194: o rubric de tier do `jev-task-routing.ts` foi avaliado com o Jev real
  sobre 78 tarefas delegadas (`audit_events`): texto antigo 60 hard, novo 32
  hard / 39 medium. Mudou o texto? Reavalie no mesmo conjunto antes de
  publicar. Um rubric de esforço novo SUBIU o esforço e foi descartado. No
  `scoreRouteCandidate`, `hard` pesa custo ×1,5 (igual medium); `critical` ×0,5.
- F-195: `adapterId` explícito sem pedido do operador vira `preferAdapterIds`
  (preferência leve) para orquestrador de qualquer missão e pin do pane do
  operador. Literal só com `operatorChoice`, `resume`, reserva de rota, roster
  ou CLI digitada no próprio pane nos últimos 15 min (`operator-cli-mentions.ts`,
  input humano só em RAM — nunca persistir, logar nem encaminhar).
- F-196: `nexus_pane_read`/`read_many` padrão `digest` para o orquestrador
  (`pane-output-digest.ts` + `classifyPaneTailForDigest`); `mode:'full'` é o
  texto cru. `nexus_handoff_list` compacta artifacts de entregues antigos (fora
  das 5 mais recentes/não entregues/`ids`); `detail:'full'` desliga.
- F-197: `idle-helper-reuse.ts` — reuso de helper parado (mesmo dono, mesma
  CLI, mesmo modo, ≥20 s parado pelo status semântico) só no pane do operador
  e na missão da aba; o Jev (`helperReuse`) escolhe ou `none`, aceita ≥ 0,7.
  Título do pane entra no critério só como caminho do state, nunca como texto.

## Missão que morre e volta: o que o trace mostra (F-187/F-211/F-212/F-213)

- `main.trace.ndjson` registra `agent-pty-terminate` (origem estável de todo
  término pedido pelo Nexus) e `agent-pty-exit` (código, sinal, tempo de vida
  e `terminationOrigin`; `null` = o processo saiu sozinho) para todo PTY de
  CLI-agente, inclusive o pane direto do operador. Chamada nova de
  `orchTerminateSession`/kill precisa passar `origin`; sem ela o trace diz
  `unlabeled`. Nunca grave argv, ambiente ou texto nesses eventos.
- `pane-spawn-timing` mede cada nascimento de pane (renderer: `rendererWaitMs`
  e fases do main; MCP: rota, isolamento, credencial, alocação, prompt).
  `rendererWaitMs` é telemetria: clampado em 0–600000 e nunca pode reprovar um
  spawn.
- Conversas Codex moram em `<userData>/provider-state/codex/<checkoutId>/
  sessions` (F-566). O `CodexUsageScanner` lê essas raízes
  (`codexSessionsDirsFor`) e o vínculo de rollout novo a exatamente um launch
  grava `provider_pane_sessions` com a conta do launch — é o que permite
  `codex resume <id>` no religamento de pane com conta fixada.
- Remount automático (`retry-kickoff`, ressurreição do escopo) adota uma sessão
  de orquestrador registrada e viva (`orchestrator-live-adopted`) quando
  `liveOrchestratorSessionId` não a reconhece; só o Retomar do operador pode
  encerrar e substituir um Maestro vivo.
