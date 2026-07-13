import { describe, expect, it } from 'vitest';
import {
  ACCEPT_DEFAULT_PROMPT_RESPONSE,
  ACCEPT_SECOND_PROMPT_RESPONSE,
  BUILTIN_PROMPT_SIGNATURES,
  CliPromptAutoResponder,
  matchesPromptSignature,
} from './cli-prompt-autoresponder';

const AGY_TRUST_PROMPT = `
Accessing workspace:

/Users/cleofasrocha/dev

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here

> Yes, I trust this folder
  No, exit
`;

const GROK_TRUST_PROMPT = `
Do you trust the contents of this directory?

Grok Build may run or modify contents in this directory, posing security risks.

> Yes, proceed
  No, exit
`;

/** Live Claude Code 2.1.x UI (also used by GLM/Longcat) — no "Enter to confirm". */
const CLAUDE_BYPASS_PROMPT_21 = `
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before
running potentially dangerous commands.
This mode should only be used in a sandboxed container/VM that has
restricted internet access and can easily be restored if damaged.

By proceeding, you accept all responsibility for actions taken
while running in Bypass Permissions mode.

https://code.claude.com/docs/en/security
› 1. No, exit
  2. Yes, I accept
`;

/** Older fixture that still included the footer — must keep matching. */
const CLAUDE_BYPASS_PROMPT_LEGACY = `
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before
running potentially dangerous commands.

By proceeding, you accept all responsibility for actions taken while running
in Bypass Permissions mode.

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`;

function signature(name: string) {
  const found = BUILTIN_PROMPT_SIGNATURES.find((item) => item.name === name);
  if (!found) throw new Error(`missing signature ${name}`);
  return found;
}

describe('CLI prompt autoresponder', () => {
  it('recognizes the Antigravity workspace trust prompt', () => {
    expect(
      matchesPromptSignature(AGY_TRUST_PROMPT, signature('agy-workspace-trust')),
    ).toBe(true);
  });

  it('recognizes the Grok folder trust prompt', () => {
    expect(
      matchesPromptSignature(GROK_TRUST_PROMPT, signature('grok-folder-trust')),
    ).toBe(true);
  });

  it('recognizes and accepts the Claude 2.1.x bypass acknowledgement (GLM shell)', () => {
    expect(
      matchesPromptSignature(
        CLAUDE_BYPASS_PROMPT_21,
        signature('claude-bypass-acknowledgement'),
      ),
    ).toBe(true);
    expect(
      matchesPromptSignature(
        CLAUDE_BYPASS_PROMPT_LEGACY,
        signature('claude-bypass-acknowledgement'),
      ),
    ).toBe(true);

    for (const adapterId of ['claude', 'glm', 'longcat'] as const) {
      const responder = new CliPromptAutoResponder();
      responder.bind(`session-${adapterId}`, adapterId);
      expect(responder.observe(`session-${adapterId}`, CLAUDE_BYPASS_PROMPT_21)).toBe(
        ACCEPT_SECOND_PROMPT_RESPONSE,
      );
      expect(responder.observe(`session-${adapterId}`, CLAUDE_BYPASS_PROMPT_21)).toBeNull();
    }
  });

  it('defers injection once the bypass banner is visible and after accept (GLM)', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-glm', 'glm');
    expect(responder.shouldDeferInjection('session-glm')).toBe(false);

    // Banner alone (options may still be painting) must hold mission inject.
    expect(
      responder.observe(
        'session-glm',
        'WARNING: Claude Code running in Bypass Permissions mode\n',
      ),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);

    expect(responder.observe('session-glm', CLAUDE_BYPASS_PROMPT_21)).toBe(
      ACCEPT_SECOND_PROMPT_RESPONSE,
    );
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
  });

  it('does not treat generic trust text as a supported CLI prompt', () => {
    expect(
      matchesPromptSignature(
        'Do you trust the contents of this project?',
        signature('agy-workspace-trust'),
      ),
    ).toBe(false);
  });

  it('accepts a prompt split across terminal chunks only once', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-1', 'agy');

    expect(
      responder.observe('session-1', AGY_TRUST_PROMPT.slice(0, 80)),
    ).toBeNull();
    expect(responder.observe('session-1', AGY_TRUST_PROMPT.slice(80))).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
    expect(responder.observe('session-1', AGY_TRUST_PROMPT)).toBeNull();
  });

  it('uses adapter-specific prompt signatures', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-1', 'grok');

    expect(responder.observe('session-1', AGY_TRUST_PROMPT)).toBeNull();
    expect(responder.observe('session-1', GROK_TRUST_PROMPT)).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
  });

  it('ignores sessions for adapters without a supported prompt signature', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-1', 'codex');

    expect(responder.observe('session-1', AGY_TRUST_PROMPT)).toBeNull();
  });

  it('stops watching after the boot window so long sessions do not stripAnsi forever', () => {
    const responder = new CliPromptAutoResponder();
    const t0 = 1_000_000;
    responder.bind('session-glm', 'glm', t0);
    expect(responder.isPending('session-glm', t0 + 1_000)).toBe(true);
    expect(responder.isPending('session-glm', t0 + 21_000)).toBe(false);
  });

  it('forceAcceptResponse dismisses a visible bypass menu for inject recovery', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-glm', 'glm');
    responder.observe(
      'session-glm',
      'WARNING: Claude Code running in Bypass Permissions mode\n',
    );
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
    expect(responder.forceAcceptResponse('session-glm')).toBe(
      ACCEPT_SECOND_PROMPT_RESPONSE,
    );
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
  });
});
