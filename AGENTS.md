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
