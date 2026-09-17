import { describe, expect, it, vi } from 'vitest';
import type { JevResult, judge as jevJudge } from './jev-client';
import { triageCommandFailure } from './jev-terminal-triage';

function result(choice = 'flaky', retry = 0.8): JevResult {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 200, output_tokens: 15 },
    answers: {
      kind: {
        type: 'choice',
        choice,
        probabilities: { [choice]: 0.9 },
        confidence: 0.9,
      },
      retry_helps: { type: 'noul', noul: retry },
    },
  };
}

const enabled = () => true;
const hasKey = () => true;
const input = { command: 'npm test', exitCode: 1, output: 'EADDRINUSE :5173' };

describe('triageCommandFailure', () => {
  it('returns null when the surface is disabled or there is no key', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await triageCommandFailure(input, {
        judge,
        enabled: () => false,
        hasKey,
      }),
    ).toBeNull();
    expect(
      await triageCommandFailure(input, {
        judge,
        enabled,
        hasKey: () => false,
      }),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns null for exitCode 0 or empty output', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await triageCommandFailure({ ...input, exitCode: 0 }, { judge, enabled, hasKey }),
    ).toBeNull();
    expect(
      await triageCommandFailure({ ...input, output: '  ' }, { judge, enabled, hasKey }),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('maps the choice and retry_helps noul', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result('flaky', 0.85));
    const triage = await triageCommandFailure(input, { judge, enabled, hasKey });
    expect(triage).toMatchObject({
      kind: 'flaky',
      confidence: 0.9,
      retryHelps: 0.85,
      model: 'jev-1.13.0',
    });
    const state = judge.mock.calls[0]![0].state as {
      command: string;
      exitCode: number;
      output: string;
    };
    expect(state.command).toBe('npm test');
    expect(state.exitCode).toBe(1);
    expect(state.output).toContain('EADDRINUSE');
  });

  it('keeps the output tail when it exceeds the cap', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result());
    const output = 'HEAD-LINE\n' + 'x'.repeat(10_000) + '\nTAIL-LINE';
    await triageCommandFailure(
      { ...input, output },
      { judge, enabled, hasKey },
    );
    const state = judge.mock.calls[0]![0].state as { output: string };
    expect(state.output).toContain('TAIL-LINE');
    expect(state.output).not.toContain('HEAD-LINE');
    expect(state.output.length).toBeLessThan(7_000);
  });

  it('unknown choice maps to regression', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => result('bogus'));
    const triage = await triageCommandFailure(input, { judge, enabled, hasKey });
    expect(triage?.kind).toBe('regression');
  });

  it('judge null → null (fail-open)', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => null);
    expect(
      await triageCommandFailure(input, { judge, enabled, hasKey }),
    ).toBeNull();
  });
});
