import { describe, expect, it } from 'vitest';
import {
  DELEGATION_PROMPT_MAX_CHARS,
  isExecutionReadyDelegationPrompt,
  prepareDelegationPrompt,
} from './delegation-prompt';

describe('prepareDelegationPrompt', () => {
  it('turns a raw realtime briefing into an execution-ready mission', () => {
    const prompt = prepareDelegationPrompt('corrigir o login que trava no Google');

    expect(prompt).toContain('Objective: corrigir o login que trava no Google');
    expect(prompt).toContain('Execution requirements:');
    expect(prompt).toContain('Acceptance criteria:');
    expect(prompt).toContain('Inspect the existing implementation');
    expect(prompt).toContain('Run the relevant focused checks');
  });

  it('recognizes a structured mission even when a provider mislabeled it as a command', () => {
    expect(isExecutionReadyDelegationPrompt([
      'Objective: Investigate the scheduling bug.',
      'Execution requirements:',
      '- Inspect logs and source code.',
      'Acceptance criteria:',
      '- Identify the trigger.',
    ].join('\n'))).toBe(true);
    expect(isExecutionReadyDelegationPrompt('npm run test\nnpm run typecheck')).toBe(false);
  });

  it('preserves a provider-authored structured briefing without duplicating it', () => {
    const briefing = [
      'Objective: Fix Google login.',
      '',
      'Execution requirements:',
      '- Preserve email/password login.',
      '',
      'Acceptance criteria:',
      '- Google login reaches the dashboard.',
    ].join('\n');

    expect(prepareDelegationPrompt(briefing)).toBe(briefing);
  });

  it('bounds oversized speech while retaining the execution contract', () => {
    const prompt = prepareDelegationPrompt('x'.repeat(10_000));

    expect(prompt.length).toBeLessThanOrEqual(DELEGATION_PROMPT_MAX_CHARS);
    expect(prompt).toContain('Acceptance criteria:');
  });
});
