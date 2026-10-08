import { describe, expect, it } from 'vitest';
import {
  acpAutoApprovedOptionId,
  acpPermissionOptionId,
  approvalOptionsFor,
  claudePermissionHookOutput,
  codexPermissionHookOutput,
} from './approval-decision-mapping';

// Payload real do PermissionRequest do claude 2.1.283 (sonda x2, `touch` num
// diretório temporário): só addDirectories + setMode — nenhum addRules.
const PROBE_BASH_SUGGESTIONS = [
  { type: 'addDirectories', directories: ['/tmp/x2-probe/cwd'], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

describe('Claude PermissionRequest hook output (golden)', () => {
  it('accept', () => {
    expect(JSON.stringify(claudePermissionHookOutput('accept', { toolName: 'Bash' }))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  });

  it('acceptForSession keeps only addRules suggestions, forced to the session', () => {
    const output = claudePermissionHookOutput('acceptForSession', {
      toolName: 'Bash',
      permissionSuggestions: [
        ...PROBE_BASH_SUGGESTIONS,
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'touch:*', injected: true }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ],
    });
    expect(JSON.stringify(output)).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow",' +
        '"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch:*"}],' +
        '"behavior":"allow","destination":"session"}]}}}',
    );
  });

  it('acceptForSession on a shell without addRules degrades to allow-once (no broad Bash rule)', () => {
    expect(
      claudePermissionHookOutput('acceptForSession', {
        toolName: 'Bash',
        permissionSuggestions: PROBE_BASH_SUGGESTIONS,
      }),
    ).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('acceptForSession on a non-shell tool falls back to the T3 tool rule', () => {
    expect(claudePermissionHookOutput('acceptForSession', { toolName: 'Write' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [
            { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' },
          ],
        },
      },
    });
  });

  it('decline and cancel deny; only cancel interrupts', () => {
    expect(JSON.stringify(claudePermissionHookOutput('decline', { toolName: 'Bash' }))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"User declined tool execution."}}}',
    );
    expect(JSON.stringify(claudePermissionHookOutput('cancel', { toolName: 'Bash' }))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"User cancelled tool execution.","interrupt":true}}}',
    );
  });
});

describe('Codex PermissionRequest hook output (golden)', () => {
  it('only allow/deny ever leave — never updatedPermissions or interrupt', () => {
    const allow = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    expect(JSON.stringify(codexPermissionHookOutput('accept'))).toBe(allow);
    expect(JSON.stringify(codexPermissionHookOutput('acceptForSession'))).toBe(allow);
    expect(JSON.stringify(codexPermissionHookOutput('decline'))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"User declined tool execution."}}}',
    );
    for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel'] as const) {
      const text = JSON.stringify(codexPermissionHookOutput(decision));
      expect(text).not.toContain('updatedPermissions');
      expect(text).not.toContain('interrupt');
      expect(text).not.toContain('updatedInput');
    }
  });
});

describe('card options', () => {
  it('Codex always says "session" degrades to this request', () => {
    expect(approvalOptionsFor('codex', { toolName: 'Edit' })).toEqual([
      { optionId: 'accept' },
      { optionId: 'acceptForSession', degradesTo: 'accept' },
      { optionId: 'decline' },
    ]);
  });

  it('Claude degrades only where no safe session scope exists', () => {
    expect(approvalOptionsFor('claude', { toolName: 'Bash', permissionSuggestions: PROBE_BASH_SUGGESTIONS })[1]).toEqual({
      optionId: 'acceptForSession',
      degradesTo: 'accept',
    });
    expect(approvalOptionsFor('claude', { toolName: 'Write' })[1]).toEqual({ optionId: 'acceptForSession' });
  });
});

describe('ACP option selection', () => {
  const options = [
    { optionId: 'always', kind: 'allow_always' },
    { optionId: ' once ', kind: 'allow_once' },
    { optionId: 'no', kind: 'reject_once' },
  ];

  it('maps decisions to native option ids', () => {
    expect(acpPermissionOptionId('accept', options)).toBe('once');
    expect(acpPermissionOptionId('acceptForSession', options)).toBe('always');
    expect(acpPermissionOptionId('decline', options)).toBe('no');
    expect(acpPermissionOptionId('cancel', options)).toBeUndefined();
  });

  it('auto-approval prefers allow_once (Grok allow_always is project-wide)', () => {
    expect(acpAutoApprovedOptionId(options)).toBe('once');
    expect(acpAutoApprovedOptionId([{ optionId: 'always', kind: 'allow_always' }])).toBe('always');
  });
});
