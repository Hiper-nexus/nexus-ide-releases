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
| `npm run release:candidate` | Release gate (typecheck + test + security) |
| `npm run release:security` | Security gate (renderer sinks + audit) |

## Authoritative Owners

- **Visual design tokens and component styles**: `DESIGN.md`
- **Architecture and module boundaries**: `docs/ARCHITECTURE.md`
- **Security boundaries and threat model**: `docs/SECURITY.md`
- **Co-located tests**: every source file has a `.test.ts` sibling — run it
  after editing the source.

## Conventions

- Co-located tests: `foo.ts` → `foo.test.ts` in the same directory.
- Run the focused test before delivery: `npx vitest run path/to/file.test.ts`.
- Run `npm run typecheck` after any source change.
- The build chain (`premake` / `prepackage`) enforces typecheck, renderer-sink
  security, and native checks before build or package.
