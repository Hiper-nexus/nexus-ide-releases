// Native per-flavor STATUS hook configs — the Nexus wiring half of the emdash
// hook-protocol harvest (wave 1). These writers extend what the spawn path
// ALREADY writes per session for MCP (never the user's real profile or the
// workspace — see the deliberate divergences below):
//
//  - Claude family: hooks merge into the per-session settings files from
//    hooks-gen.ts (ephemeral-HOME settings.json for gated workers, the
//    --settings flag file for real-HOME panes). Emdash writes
//    .claude/settings.local.json INTO the workspace instead; Nexus does not
//    touch project files (divergence, same event coverage).
//  - Codex: hooks ship as per-session `-c` argv config overrides — the exact
//    mechanism codexMcpArgs already uses for MCP. Emdash merges [hooks] into
//    ~/.codex/config.toml with legacy hooks.json migration; Nexus never
//    mutates the user's real Codex profile (divergence). Caveat: a -c
//    override shadows a same-key user hook for the session only.
//  - Kimi: flat `hooks = [{event, command}]` merged into the private
//    KIMI_CODE_HOME overlay's config.toml (excluded from auth sync-back).
//  - Grok: dedicated `hooks/nexus.json` inside the private GROK_HOME overlay
//    (user hooks in the real hooks/ dir are symlinked through).
//
// Every command carries the NEXUS_HOOK_STATUS marker, references
// $NEXUS_HOOK_URL / $NEXUS_GATE_TOKEN (never a literal secret), and ends in
// `|| true` / SilentlyContinue — a status hook can never block the CLI. The
// skill-gate .mjs enforcement hooks are a separate channel and untouched here.

import {
  claudeHookSpecs,
  codexHookSpecs,
  grokHookSpecs,
  kimiHookSpecs,
} from '../../vendor/emdash/hooks/flavors';
import {
  buildNestedEntry,
  mergeNestedEntries,
} from '../../vendor/emdash/hooks/hook-config';
import { filterUserHooks } from '../../vendor/emdash/hooks/hook-commands';
import { makeClaudeTriageHookCommand } from './hook-triage-command';
import { makeDelegateHookCommand } from './hook-delegate-command';

// ── Claude (family: claude/glm/glm-flash/longcat) ───────────────────────────

export type ClaudeHooksMap = Record<string, unknown[]>;

/**
 * Merge the status hooks (UserPromptSubmit → start, Notification →
 * notification, Stop → stop) into a Claude settings `hooks` map. Marker-aware:
 * prior Nexus entries are replaced (idempotent per-spawn rewrite), skill-gate
 * and user entries are preserved.
 */
export function mergeClaudeStatusHooks(existing: ClaudeHooksMap): ClaudeHooksMap {
  const next: ClaudeHooksMap = { ...existing };
  for (const spec of claudeHookSpecs()) {
    const current = Array.isArray(next[spec.hookKey]) ? next[spec.hookKey] : [];
    next[spec.hookKey] = mergeNestedEntries(current, spec.command);
  }
  // PostToolUseFailure/Bash → POST /hook/triage: a RESPOSTA do endpoint vira o
  // output do hook (additionalContext), então o comando não usa
  // `--output /dev/null`. O mergeNestedEntries acima já removeu entradas
  // antigas com o marker, então a reescrita por spawn segue idempotente.
  const failure = Array.isArray(next.PostToolUseFailure)
    ? next.PostToolUseFailure
    : [];
  next.PostToolUseFailure = [
    ...failure,
    {
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: makeClaudeTriageHookCommand(), timeout: 15 },
      ],
    },
  ];
  // UserPromptSubmit → POST /hook/delegate (C2): o conselho do Jev vira
  // additionalContext. O loop de status acima já removeu as entradas antigas
  // com o marker neste evento, então a reescrita por spawn segue idempotente.
  const prompt = Array.isArray(next.UserPromptSubmit) ? next.UserPromptSubmit : [];
  next.UserPromptSubmit = [
    ...prompt,
    {
      hooks: [
        { type: 'command', command: makeDelegateHookCommand(), timeout: 5 },
      ],
    },
  ];
  return next;
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** Escape a command line as a TOML basic string for `-c key=value` overrides. */
function tomlBasicString(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) =>
        `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ) +
    '"'
  );
}

/**
 * Codex hook overrides in the same `-c` argv form codexMcpArgs uses:
 *   -c 'hooks.Stop=[{hooks=[{type="command",command="…"}]}'
 * Deterministic (no random), so re-spawns produce identical argv — idempotent
 * by construction with zero disk writes.
 */
export function codexStatusHookArgs(): string[] {
  const args: string[] = [];
  for (const spec of codexHookSpecs()) {
    // UserPromptSubmit também pede contexto ao /hook/delegate, no MESMO array:
    // um segundo `-c` com a mesma chave sombrearia o hook de status.
    const commands =
      spec.hookKey === 'UserPromptSubmit'
        ? [spec.command, makeDelegateHookCommand()]
        : [spec.command];
    const hooks = commands
      .map((command) => `{type="command",command=${tomlBasicString(command)}}`)
      .join(',');
    args.push('-c', `hooks.${spec.hookKey}=[{hooks=[${hooks}]}]`);
  }
  return args;
}

// ── Kimi ────────────────────────────────────────────────────────────────────

/**
 * Merge Kimi's flat `hooks = [{ event, command }]` array into a parsed
 * config.toml object (marker-deduped; user entries preserved).
 */
export function mergeKimiStatusHooks(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const existing = Array.isArray(config.hooks)
    ? (config.hooks as Record<string, unknown>[])
    : [];
  const userEntries = filterUserHooks(existing);
  const nexusEntries = kimiHookSpecs().map((spec) => ({
    event: spec.hookKey,
    command: spec.command,
  }));
  return { ...config, hooks: [...userEntries, ...nexusEntries] };
}

// ── Grok ────────────────────────────────────────────────────────────────────

/** File name of the Nexus-owned hooks doc inside the GROK_HOME overlay. */
export const GROK_STATUS_HOOKS_FILE = 'nexus.json';

/**
 * Grok resolves declarative hooks from `$GROK_HOME/hooks/*.json` as nested
 * entries under a top-level `hooks` key. The whole document is Nexus-owned
 * (rewritten per spawn), so no user merge is needed.
 */
export function grokStatusHooksDocument(): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const spec of grokHookSpecs()) {
    hooks[spec.hookKey] = [buildNestedEntry(spec.command)];
  }
  return { hooks };
}
