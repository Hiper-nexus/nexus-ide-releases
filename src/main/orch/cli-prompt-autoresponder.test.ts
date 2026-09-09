import { describe, expect, it } from 'vitest';
import {
  ACCEPT_DEFAULT_PROMPT_RESPONSE,
  ACCEPT_FIRST_OPTION_BY_NUMBER,
  ACCEPT_SECOND_OPTION_BY_NUMBER,
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

/** Kimi Code 0.41/0.42 — transcrito ao vivo na primeira abertura numa pasta. */
const KIMI_TRUST_PROMPT = `
Trust this folder?
↑↓ navigate · Enter select · Esc exit

/private/tmp/kimi-trust-fresh-1

Project-level MCP servers are disabled until you explicitly choose Trust.
Trust starts the listed project MCP targets and remembers this folder.

 ❯ Trust this folder
   Enable project MCP servers. Remembered for this folder.

   Don't trust
   Exit Kimi Code. Asked again next launch.
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

/**
 * Claude Code workspace trust dialog (also GLM/LongCat). Isolated third-party
 * homes carry no per-project trust, so the first spawn per cwd shows this.
 * Option 1 is the safe accept — Down+Enter here would pick "No, exit".
 */
const CLAUDE_TRUST_PROMPT = `
Do you trust the files in this folder?

/Users/cleofasrocha/dev/radarbi

Claude Code may read files in this folder. Reading unknown files may lead to
malicious behavior. Claude will not execute commands without your approval.

› 1. Yes, proceed
  2. No, exit
`;

/** Claude Code 2.1.220 workspace trust copy observed in the physical E2E. */
const CLAUDE_TRUST_PROMPT_220 = `
Quick safety check: Is this a project you created or one you trust?

/tmp/nexus-final-e2e

› 1. Yes, I trust this folder
  2. No, exit
`;

function signature(name: string) {
  const found = BUILTIN_PROMPT_SIGNATURES.find((item) => item.name === name);
  if (!found) throw new Error(`missing signature ${name}`);
  return found;
}

describe('CLI prompt autoresponder', () => {
  it('has a fail-closed runtime kill switch that prevents every automatic keypress', () => {
    const responder = new CliPromptAutoResponder(() => false);
    responder.bind('session-glm', 'glm');

    expect(responder.isPending('session-glm')).toBe(false);
    expect(responder.observe('session-glm', CLAUDE_BYPASS_PROMPT_21)).toBeNull();
    expect(responder.shouldDeferInjection('session-glm')).toBe(false);
    expect(responder.forceAcceptResponse('session-glm')).toBeNull();
  });

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

  it('recognizes and accepts the Kimi folder trust prompt with Enter', () => {
    // Campo 09/09: o Kimi 0.42 para em "Trust this folder?" antes do composer;
    // sem resposta a pane fica muda e o prompt da missão é engolido pelo modal.
    expect(
      matchesPromptSignature(KIMI_TRUST_PROMPT, signature('kimi-folder-trust')),
    ).toBe(true);

    const responder = new CliPromptAutoResponder();
    responder.bind('session-kimi', 'kimi');
    expect(responder.observe('session-kimi', KIMI_TRUST_PROMPT)).toBe(
      ACCEPT_DEFAULT_PROMPT_RESPONSE,
    );
    expect(responder.observe('session-kimi', KIMI_TRUST_PROMPT)).toBeNull();
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
    expect(responder.forceAcceptResponse('session-glm')).toEqual({
      response: ACCEPT_SECOND_PROMPT_RESPONSE,
      fallbackResponse: ACCEPT_SECOND_OPTION_BY_NUMBER,
    });
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);
  });

  it('recognizes and accepts the Claude-family workspace trust dialog', () => {
    expect(
      matchesPromptSignature(
        CLAUDE_TRUST_PROMPT,
        signature('claude-workspace-trust'),
      ),
    ).toBe(true);

    for (const adapterId of ['claude', 'glm', 'longcat'] as const) {
      const responder = new CliPromptAutoResponder();
      responder.bind(`session-${adapterId}`, adapterId);
      expect(responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT)).toBe(
        ACCEPT_FIRST_OPTION_BY_NUMBER,
      );
      expect(responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT)).toBeNull();
    }
  });

  it('recognizes the Claude 2.1.220 quick-safety trust dialog', () => {
    expect(
      matchesPromptSignature(
        CLAUDE_TRUST_PROMPT_220,
        signature('claude-workspace-trust-quick-safety-check'),
      ),
    ).toBe(true);

    for (const adapterId of ['claude', 'glm', 'longcat'] as const) {
      const responder = new CliPromptAutoResponder();
      responder.bind(`session-${adapterId}`, adapterId);
      expect(
        responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT_220),
      ).toBe(ACCEPT_FIRST_OPTION_BY_NUMBER);
      expect(
        responder.observe(`session-${adapterId}`, CLAUDE_TRUST_PROMPT_220),
      ).toBeNull();
    }
  });

  it('defers on the partial Claude 2.1.220 banner and force-accepts option 1', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-claude', 'claude');

    expect(
      responder.observe(
        'session-claude',
        'Quick safety check: Is this a project\n',
      ),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-claude')).toBe(true);
    expect(responder.forceAcceptResponse('session-claude')).toEqual({
      response: ACCEPT_FIRST_OPTION_BY_NUMBER,
    });
  });

  it('defers injection on the trust banner and force-accepts with option 1 (never Down+Enter)', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('session-glm', 'glm');
    expect(
      responder.observe('session-glm', 'Do you trust the files in this folder?\n'),
    ).toBeNull();
    expect(responder.shouldDeferInjection('session-glm')).toBe(true);

    // Regression guard: the generic force-accept used to be Down+Enter, which
    // on this menu selects "No, exit" and kills the CLI session.
    expect(responder.forceAcceptResponse('session-glm')).toEqual({
      response: ACCEPT_FIRST_OPTION_BY_NUMBER,
    });
  });
});
