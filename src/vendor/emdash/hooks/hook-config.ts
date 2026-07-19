// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/helpers/hook-config.ts
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations: only the PURE entry builders and marker-aware merge
// helpers are vendored. Emdash's async PluginFs read/write/delete lifecycle
// (readHooks/writeHooks/deleteHooks/getHooksInstalled) is not — Nexus writes
// native configs per-spawn in src/main/orch/hook-status-config.ts with its own
// atomic-write and TOML (smol-toml) helpers, so the two layers stay separate.

import { filterUserHooks } from './hook-commands';

// ── Entry builders ──────────────────────────────────────────────────────────

/** Claude/Codex-style nested entry: `{ hooks: [{ type: 'command', command }] }` */
export function buildNestedEntry(command: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command }] };
}

/** Copilot-style flat entry: `{ type: 'command', command }` */
export function buildFlatEntry(command: string): Record<string, unknown> {
  return { type: 'command', command };
}

/** Kiro-style minimal entry: `{ command }` */
export function buildMinimalEntry(command: string): Record<string, unknown> {
  return { command };
}

// ── Merge helpers ───────────────────────────────────────────────────────────
// Each merge DROPS prior Nexus-managed entries (marker match) before appending
// the fresh one, which is what makes a per-spawn rewrite idempotent.

export function mergeNestedEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildNestedEntry(command)];
}

export function mergeFlatEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildFlatEntry(command)];
}

export function mergeMinimalEntries(existing: unknown[], command: string): unknown[] {
  return [...filterUserHooks(existing as Record<string, unknown>[]), buildMinimalEntry(command)];
}
