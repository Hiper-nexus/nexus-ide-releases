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
  efeito, dentro de missão e fora da mão do operador (`role user` nunca é
  julgado), passa por três nouls — coerente com o objetivo da missão
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
  `taskRouting`): tier e especialidade julgados numa chamada, cada campo
  aceito só com confiança ≥ 0.6 (senão a heurística de palavras-chave, por
  campo); `tier` passado pelo chamador continua mandando;
  `specialtyOverride` é seam aditivo do `RouteContext` (política/benchmark/
  catálogo/reserva intocados). Resultado ganha `classifierSource`
  (`jev|heuristic|mixed`) e `escalate` (0..1) — informação para o Maestro,
  nunca decisão do router.
- `nexus_browser_do` ("Jev decide, Nexus executa"): UMA confirmação humana
  por objetivo; ação irreversível/custosa sempre para em `needs_confirmation`
  e devolve a proposta; trava de origem (`left_origin`); textos digitados são
  só os `values` fornecidos (Jev escolhe o label); cap de passos
  (`maxSteps ≤ 40`); uma entrada no decision log por passo.
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
