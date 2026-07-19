// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: packages/core/src/agents/plugins/helpers/hook-config.ts (behavior)
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations: upstream covers the merge helpers through the async
// PluginFs behaviors; this suite pins the pure-builder + merge semantics the
// Nexus per-spawn config writers rely on (user-hook preservation, marker
// dedupe → idempotent rewrite).

import { describe, expect, it } from 'vitest';
import {
  buildFlatEntry,
  buildMinimalEntry,
  buildNestedEntry,
  mergeFlatEntries,
  mergeMinimalEntries,
  mergeNestedEntries,
} from './hook-config';
import { makeStdinHookCommand } from './hook-commands';

const STOP_COMMAND = makeStdinHookCommand('stop', { platform: 'linux', flavor: 'claude' });
const START_COMMAND = makeStdinHookCommand('start', { platform: 'linux', flavor: 'claude' });

describe('entry builders', () => {
  it('builds the nested (Claude/Codex) entry shape', () => {
    expect(buildNestedEntry('cmd')).toEqual({ hooks: [{ type: 'command', command: 'cmd' }] });
  });

  it('builds the flat and minimal entry shapes', () => {
    expect(buildFlatEntry('cmd')).toEqual({ type: 'command', command: 'cmd' });
    expect(buildMinimalEntry('cmd')).toEqual({ command: 'cmd' });
  });
});

describe('merge helpers', () => {
  it('appends a nested entry preserving user hooks', () => {
    const user = { hooks: [{ type: 'command', command: 'echo user-stop' }] };
    expect(mergeNestedEntries([user], STOP_COMMAND)).toEqual([
      user,
      buildNestedEntry(STOP_COMMAND),
    ]);
  });

  it('replaces a prior Nexus entry instead of duplicating it (idempotent rewrite)', () => {
    const user = { hooks: [{ type: 'command', command: 'echo user-stop' }] };
    const once = mergeNestedEntries([user], STOP_COMMAND);
    const twice = mergeNestedEntries(once, START_COMMAND);

    expect(twice).toEqual([user, buildNestedEntry(START_COMMAND)]);
  });

  it('flat and minimal merges share the same marker-dedupe semantics', () => {
    const onceFlat = mergeFlatEntries([], STOP_COMMAND);
    expect(mergeFlatEntries(onceFlat, STOP_COMMAND)).toEqual(onceFlat);

    const onceMinimal = mergeMinimalEntries([], STOP_COMMAND);
    expect(mergeMinimalEntries(onceMinimal, STOP_COMMAND)).toEqual(onceMinimal);
  });
});
