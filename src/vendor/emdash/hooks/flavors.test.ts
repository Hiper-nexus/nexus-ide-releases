// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Sources: packages/plugins/src/agents/impl/codex/hooks.test.ts (parse cases),
// claude/hooks.ts and grok/hooks.ts parseHookEvent behavior.
// See src/vendor/emdash/hooks/LICENSE.md.
// Nexus adaptations: upstream's codex suite mostly covers the PluginFs file
// lifecycle (not vendored — see flavors.ts header); the parseHookEvent cases
// are ported here against the consolidated flavor module, plus Claude/Grok
// classification and spec-table sanity (marker + flavor header on every
// generated command).

import { describe, expect, it } from 'vitest';
import {
  claudeHookSpecs,
  codexHookSpecs,
  grokHookSpecs,
  kimiHookSpecs,
  parseClaudeHookEvent,
  parseCodexHookEvent,
  parseFlavorHookEvent,
  parseGrokHookEvent,
} from './flavors';

describe('parseClaudeHookEvent', () => {
  it('classifies permission-ish notification text as permission_prompt', () => {
    expect(
      parseClaudeHookEvent('notification', { message: 'Claude needs your permission to run Bash' }),
    ).toMatchObject({ notificationType: 'permission_prompt' });
    expect(
      parseClaudeHookEvent('notification', { message: 'approval required' }),
    ).toMatchObject({ notificationType: 'permission_prompt' });
  });

  it('classifies the idle nudge as idle_prompt and ordinary notices as idle (F-104)', () => {
    // "Claude is waiting for your input" é o aviso de idle pós-turno — NÃO um
    // diálogo. Promovê-lo a elicitation lacrava panes de missão em
    // awaiting-input permanente (F-104, campo 21/08).
    expect(
      parseClaudeHookEvent('notification', { message: 'Claude is waiting for your input' }),
    ).toMatchObject({ notificationType: 'idle_prompt' });
    expect(
      parseClaudeHookEvent('notification', { message: 'Task completed' }),
    ).toMatchObject({ notificationType: 'idle_prompt' });
  });

  it('still classifies question/approval phrasing as elicitation', () => {
    expect(
      parseClaudeHookEvent('notification', { message: 'Claude asks the user which database to use' }),
    ).toMatchObject({ notificationType: 'elicitation_dialog' });
    expect(
      parseClaudeHookEvent('notification', { message: 'awaiting user decision on migration plan' }),
    ).toMatchObject({ notificationType: 'elicitation_dialog' });
  });

  it('falls back to the default parser for non-notification events', () => {
    expect(parseClaudeHookEvent('start', {})).toMatchObject({ kind: 'status', type: 'start' });
    expect(parseClaudeHookEvent('mystery', {})).toEqual({ kind: 'ignore' });
  });

  // Nexus F-734: payload shape of Claude Code 2.1.287's StopFailure.
  it('parses StopFailure to a stop carrying only the allowlisted category', () => {
    const providerText =
      'Please run /login · API Error: 401 Authentication Fails, Your api key: ****WXYZ is invalid';
    const event = parseClaudeHookEvent('stop-failure', {
      session_id: 'provider-session',
      transcript_path: '/tmp/t.jsonl',
      hook_event_name: 'StopFailure',
      error: 'authentication_failed',
      error_details: providerText,
      last_assistant_message: providerText,
    });
    expect(event).toEqual({ kind: 'status', type: 'stop', stopFailure: 'auth' });
    expect(JSON.stringify(event)).not.toContain('WXYZ');

    expect(parseClaudeHookEvent('stop-failure', { error: 'billing_error' })).toEqual({
      kind: 'status',
      type: 'stop',
      stopFailure: 'billing',
    });
    expect(parseClaudeHookEvent('stop-failure', { error: 'model_not_found' })).toEqual({
      kind: 'status',
      type: 'stop',
      stopFailure: 'invalid_request',
    });
    // F-1484: limite de uso tem categoria própria (prova do provedor).
    expect(parseClaudeHookEvent('stop-failure', { error: 'rate_limit' })).toEqual({
      kind: 'status',
      type: 'stop',
      stopFailure: 'rate_limit',
    });
    // Transitório e valor desconhecido: categoria `other`.
    for (const error of ['server_error', 'unknown', providerText, undefined]) {
      expect(parseClaudeHookEvent('stop-failure', { error })).toEqual({
        kind: 'status',
        type: 'stop',
        stopFailure: 'other',
      });
    }
  });

  it('a normal Stop never carries a stopFailure category', () => {
    const event = parseClaudeHookEvent('stop', {
      error: 'authentication_failed',
      last_assistant_message: 'done',
    });
    expect(event).toMatchObject({ kind: 'status', type: 'stop' });
    expect(event).not.toHaveProperty('stopFailure');
  });
});

describe('parseCodexHookEvent', () => {
  it('maps agent-turn-complete to a stop status', () => {
    expect(parseCodexHookEvent('notification', { type: 'agent-turn-complete' })).toEqual({
      kind: 'status',
      type: 'stop',
    });
  });

  it('maps fixed idle_prompt notifications to stop', () => {
    expect(parseCodexHookEvent('notification', { notification_type: 'idle_prompt' })).toEqual({
      kind: 'status',
      type: 'stop',
    });
  });

  it('maps a Stop stdin payload with last_agent_message to stop', () => {
    expect(parseCodexHookEvent('stop', { last_agent_message: '3' })).toMatchObject({
      kind: 'status',
      type: 'stop',
    });
  });

  it('maps fixed permission_prompt notifications to a permission notification', () => {
    expect(
      parseCodexHookEvent('notification', { notification_type: 'permission_prompt' }),
    ).toEqual({ kind: 'status', type: 'notification', notificationType: 'permission_prompt' });
  });

  it('extracts a session id from session-start (session_id or resource_id)', () => {
    expect(parseCodexHookEvent('session-start', { session_id: 's1' })).toEqual({
      kind: 'session',
      providerSessionId: 's1',
    });
    expect(parseCodexHookEvent('session-start', { resource_id: 'r1' })).toEqual({
      kind: 'session',
      providerSessionId: 'r1',
    });
    expect(parseCodexHookEvent('session-start', {})).toEqual({ kind: 'ignore' });
  });
});

describe('parseGrokHookEvent', () => {
  it('treats every notification as a permission prompt', () => {
    expect(parseGrokHookEvent('notification', { message: 'Allow tool?' })).toMatchObject({
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
    });
  });
});

describe('parseFlavorHookEvent dispatch', () => {
  it('routes each flavor to its parser and defaults the rest', () => {
    expect(parseFlavorHookEvent('claude', 'notification', { message: 'approval?' }))
      .toMatchObject({ notificationType: 'permission_prompt' });
    expect(parseFlavorHookEvent('codex', 'notification', { notification_type: 'idle_prompt' }))
      .toEqual({ kind: 'status', type: 'stop' });
    expect(parseFlavorHookEvent('grok', 'notification', {}))
      .toMatchObject({ notificationType: 'permission_prompt' });
    expect(parseFlavorHookEvent('kimi', 'stop', {}))
      .toMatchObject({ kind: 'status', type: 'stop' });
    expect(parseFlavorHookEvent('default', 'start', {}))
      .toMatchObject({ kind: 'status', type: 'start' });
  });

  it('distinguishes interactive question tools from parallel ordinary tools', () => {
    expect(parseFlavorHookEvent('codex', 'tool-use', {
      tool_name: 'request_user_input',
    })).toMatchObject({
      type: 'notification',
      notificationType: 'elicitation_dialog',
    });
    expect(parseFlavorHookEvent('claude', 'tool-use', {
      tool_name: 'Bash',
    })).toMatchObject({ type: 'start', clearsAwaitingInput: false });
    expect(parseFlavorHookEvent('kimi', 'tool-complete', {
      tool_name: 'AskUserQuestion',
    })).toMatchObject({ type: 'start', clearsAwaitingInput: true });
  });

  it('Nexus F-734: only the Claude flavor understands stop-failure', () => {
    expect(parseFlavorHookEvent('claude', 'stop-failure', { error: 'invalid_request' }))
      .toEqual({ kind: 'status', type: 'stop', stopFailure: 'invalid_request' });
    expect(parseFlavorHookEvent('default', 'stop-failure', { error: 'invalid_request' }))
      .toEqual({ kind: 'ignore' });
  });
});

describe('flavor hook spec tables', () => {
  const linux = { platform: 'linux' as const };

  it('covers the documented event surface per flavor', () => {
    expect(claudeHookSpecs(linux).map((s) => s.hookKey)).toEqual([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification',
      'Stop',
      'StopFailure',
    ]);
    // Nexus F-734: StopFailure pipes stdin under its own event type, so the
    // endpoint can tell it from a Stop (never a mechanical turn-end handoff).
    const claudeStopFailure = claudeHookSpecs(linux).find(
      (spec) => spec.hookKey === 'StopFailure',
    );
    expect(claudeStopFailure?.command).toContain('-d @-');
    expect(claudeStopFailure?.command).toContain('X-Nexus-Hook-Event: stop-failure');
    expect(codexHookSpecs(linux).map((s) => s.hookKey)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
      'PermissionRequest',
    ]);
    const codexStop = codexHookSpecs(linux).find((spec) => spec.hookKey === 'Stop');
    expect(codexStop?.command).toContain('-d @-');
    expect(codexStop?.command).toContain('X-Nexus-Hook-Event: stop');
    expect(codexStop?.command).not.toContain('idle_prompt');
    const permission = codexHookSpecs(linux).find(
      (spec) => spec.hookKey === 'PermissionRequest',
    );
    expect(permission?.command).toContain('permission_prompt');
    expect(kimiHookSpecs(linux).map((s) => s.hookKey)).toContain('SessionEnd');
    expect(grokHookSpecs(linux).map((s) => s.hookKey)).toContain('SessionEnd');
  });

  it('every generated command carries the marker, flavor header and env-only auth', () => {
    for (const [flavor, specs] of [
      ['claude', claudeHookSpecs(linux)],
      ['codex', codexHookSpecs(linux)],
      ['kimi', kimiHookSpecs(linux)],
      ['grok', grokHookSpecs(linux)],
    ] as const) {
      for (const spec of specs) {
        expect(spec.command).toContain('NEXUS_HOOK_STATUS');
        expect(spec.command).toContain('--output /dev/null');
        expect(spec.command).toContain(`X-Nexus-Hook-Flavor: ${flavor}`);
        expect(spec.command).toContain('$NEXUS_GATE_TOKEN');
        expect(spec.command).toContain('$NEXUS_HOOK_URL');
        expect(spec.command).toContain('|| true');
      }
    }
  });
});
