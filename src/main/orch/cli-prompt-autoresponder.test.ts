import { describe, expect, it } from 'vitest';
import {
  ACCEPT_DEFAULT_PROMPT_RESPONSE,
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
});
