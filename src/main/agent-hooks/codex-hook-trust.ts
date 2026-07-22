// Codex CLI >= 0.129 refuses to run unmanaged hooks until the user reviews
// them in the TUI ("N hooks need review before they run / Press t to trust
// all") — a fatal blocker for an orchestrator booting Codex panes. The trust
// decision is persisted in ~/.codex/config.toml as
// `[hooks.state."<key>"] trusted_hash = "sha256:<hex>"`; when the hash matches
// the hook's current_hash the hook runs with no review. This module reproduces
// the exact key + hash algorithm of codex-rs (discovery.rs /
// command_hook_hash, verified live against codex 0.145.0 app-server
// hooks/list) so the consented Nexus installer can pre-trust the hooks it
// writes, and edits config.toml TEXTUALLY (never a serializer round-trip) to
// preserve the user's comments and formatting.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HookDefinition, HooksConfig } from './installer-utils';

export type CodexHookTrustEntry = {
  key: string;
  trustedHash: string;
};

/** Events whose matcher is ignored by codex (normalized to None). */
const MATCHERLESS_EVENTS = new Set(['user_prompt_submit', 'stop']);

/** Events allowed to carry additionalContextLimit in the hook identity. */
const CONTEXT_LIMIT_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'user_prompt_submit',
  'subagent_start',
]);

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CONTEXT_LIMIT = 2500;

/** PascalCase hook event → snake_case codex event name. */
export function codexHookEventName(eventName: string): string {
  return eventName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Canonical JSON per codex-rs: objects with keys sorted recursively, compact
 * separators, array order preserved.
 */
export function canonicalJsonString(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonString(record[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 (prefixed `sha256:`) of the canonical hook identity — the exact
 * digest codex compares against `hooks.state` trusted_hash.
 */
export function codexHookIdentityHash(identity: Record<string, unknown>): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonString(identity), 'utf8')
    .digest('hex')}`;
}

function realpathOrAbsolute(hooksJsonPath: string): string {
  try {
    return realpathSync(hooksJsonPath);
  } catch {
    return resolve(hooksJsonPath);
  }
}

/**
 * Trust entries (key + trusted_hash) for every managed hook found in the
 * FINAL hooks.json content. The Nexus installer appends one group with one
 * handler per event, but indices are computed from the real content (user
 * groups may precede ours). Key form:
 *   <realpath(hooks.json)>:<event_snake_case>:<groupIndex>:<handlerIndex>
 */
export function codexHookTrustEntries(
  hooksJsonPath: string,
  hooksConfig: HooksConfig,
  managedCommand: string,
): CodexHookTrustEntry[] {
  const basePath = realpathOrAbsolute(hooksJsonPath);
  const entries: CodexHookTrustEntry[] = [];
  const hooks = hooksConfig.hooks ?? {};
  for (const [eventName, definitions] of Object.entries(hooks)) {
    if (!Array.isArray(definitions)) continue;
    const snakeEvent = codexHookEventName(eventName);
    for (let groupIndex = 0; groupIndex < definitions.length; groupIndex += 1) {
      const definition = definitions[groupIndex]!;
      const handlers = Array.isArray(definition.hooks) ? definition.hooks : [];
      const handlerIndex = handlers.findIndex(
        (hook) => hook.command === managedCommand,
      );
      if (handlerIndex < 0) continue;
      const handler = handlers[handlerIndex]!;
      entries.push({
        key: `${basePath}:${snakeEvent}:${groupIndex}:${handlerIndex}`,
        trustedHash: codexHookIdentityHash(
          buildHookIdentity(snakeEvent, definition, handler),
        ),
      });
      break; // the installer writes exactly one managed group per event
    }
  }
  return entries;
}

function buildHookIdentity(
  snakeEvent: string,
  definition: HookDefinition,
  handler: { command: string; timeout?: number; [key: string]: unknown },
): Record<string, unknown> {
  const normalizedHandler: Record<string, unknown> = {
    type: 'command',
    command: handler.command,
    timeout: Math.max(
      1,
      typeof handler.timeout === 'number'
        ? handler.timeout
        : DEFAULT_TIMEOUT_SECONDS,
    ),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === 'string') {
    normalizedHandler.statusMessage = handler.statusMessage;
  }
  if (
    CONTEXT_LIMIT_EVENTS.has(snakeEvent) &&
    typeof handler.additionalContextLimit === 'number' &&
    handler.additionalContextLimit !== DEFAULT_CONTEXT_LIMIT
  ) {
    normalizedHandler.additionalContextLimit = handler.additionalContextLimit;
  }
  const identity: Record<string, unknown> = {
    event_name: snakeEvent,
    hooks: [normalizedHandler],
  };
  if (!MATCHERLESS_EVENTS.has(snakeEvent) && typeof definition.matcher === 'string') {
    identity.matcher = definition.matcher;
  }
  return identity;
}

// ── config.toml textual editing ─────────────────────────────────────────────

/** Escape a key for the quoted TOML header form `[hooks.state."<key>"]`. */
function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function trustSectionHeader(key: string): string {
  return `[hooks.state."${escapeTomlBasicString(key)}"]`;
}

/**
 * Locate `[hooks.state."<key>"]` sections. Returns the header line index and
 * the index one past the last line of each section body.
 */
function findTrustSection(
  lines: string[],
  key: string,
): { start: number; end: number } | null {
  const header = trustSectionHeader(key);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== header) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end]!.trimStart().startsWith('[')) {
      end += 1;
    }
    return { start: i, end };
  }
  return null;
}

/**
 * Insert or refresh `trusted_hash` for each entry inside the user's existing
 * config.toml text. Surgical, line-based editing: comments, formatting and
 * unrelated sections are preserved; an existing trusted_hash line inside our
 * section is replaced in place (idempotent).
 */
export function mergeCodexHookTrustState(
  configToml: string,
  entries: CodexHookTrustEntry[],
): string {
  let lines = configToml.length > 0 ? configToml.split('\n') : [];
  // Drop a single trailing empty line from the split so appends are clean;
  // it is restored when the text is re-joined below.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const entry of entries) {
    const hashLine = `trusted_hash = ${JSON.stringify(entry.trustedHash)}`;
    const section = findTrustSection(lines, entry.key);
    if (section) {
      let replaced = false;
      for (let i = section.start + 1; i < section.end; i += 1) {
        if (/^\s*trusted_hash\s*=/.test(lines[i]!)) {
          lines[i] = hashLine;
          replaced = true;
        }
      }
      if (!replaced) {
        lines.splice(section.start + 1, 0, hashLine);
      }
    } else {
      if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
        lines.push('');
      }
      lines.push(trustSectionHeader(entry.key), hashLine);
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Remove the `[hooks.state."<key>"]` sections for the given keys, tolerating
 * their absence. Everything else — comments, other sections, other trust
 * entries (including the user's own approvals) — is preserved.
 */
export function stripCodexHookTrustState(
  configToml: string,
  keys: string[],
): string {
  if (keys.length === 0 || configToml.length === 0) return configToml;
  const lines = configToml.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let removedAny = false;
  for (const key of keys) {
    const section = findTrustSection(lines, key);
    if (!section) continue;
    removedAny = true;
    lines.splice(section.start, section.end - section.start);
    // Collapse the blank-line pair a mid-file removal can leave behind.
    const at = section.start;
    if (
      at > 0 &&
      at < lines.length &&
      lines[at - 1]!.trim() === '' &&
      lines[at]!.trim() === ''
    ) {
      lines.splice(at, 1);
    }
  }
  if (!removedAny) return configToml;
  // A removal at EOF must not leave trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
