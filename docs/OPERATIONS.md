# Operations

## Contract

Local-first desktop ops: project runtime SQLite, feature flags, mission driver modes (shadow/active), smoke packaging.

## Ownership

- Main bootstrap: `src/main/main.ts`
- Project runtime: `src/main/runtime/project-runtime-manager.ts`
- Feature flags: `src/main/feature-flags/`
- Doctor: `src/main/runtime/nexus-doctor.ts`

## Error flow

DB open failure → degraded mode for legacy global DB; project runtime fails closed.
Migration failure → transactional rollback + fault code.

## Limits

WAL busy_timeout 5s; LRU open runtimes; flag overrides file 0600.

## Migration

See `INITIAL_PROJECT_MIGRATIONS` through `014-mission-events-command-blocks`.

## Rollback

Disable flags; restore `.bak` for MCP hub configs; leave empty new tables.

## Metrics

Startup/shutdown via existing perf IPC; mission driver tick counters.

## How to test

```bash
npx vitest run src/main/runtime/project-runtime-manager.test.ts
npm run typecheck
```
