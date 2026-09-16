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
