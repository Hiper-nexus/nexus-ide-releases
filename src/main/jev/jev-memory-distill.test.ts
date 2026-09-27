import { describe, expect, it, vi } from 'vitest';
import type { JevResult, judge as jevJudge } from './jev-client';
import {
  DISTILLED_SUMMARY_MAX_CHARS,
  distillHandoffSummary,
  normalizeDistilledSummary,
} from './jev-memory-distill';

function noulResult(value: number): JevResult {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 180, output_tokens: 5 },
    answers: {
      worth_retaining: { type: 'noul', noul: value },
    },
  };
}

const enabled = () => true;
const hasKey = () => true;
const summary =
  'Slice 1 shipped: accepted-handoff summaries now become recallable trusted memory lines.';

describe('jev-memory-distill', () => {
  it('returns null without calling judge when the surface is disabled', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await distillHandoffSummary(
        { summary },
        { judge, enabled: () => false, hasKey },
      ),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns null without calling judge when the key is missing', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await distillHandoffSummary(
        { summary },
        { judge, enabled, hasKey: () => false },
      ),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns null without calling judge for a blank summary', async () => {
    const judge = vi.fn<typeof jevJudge>();
    expect(
      await distillHandoffSummary(
        { summary: '   \n\t  ' },
        { judge, enabled, hasKey },
      ),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('fails open to null when judge returns null', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => null);
    expect(await distillHandoffSummary({ summary }, { judge, enabled, hasKey })).toBeNull();
  });

  it('returns the normalized summary when Jev says it is worth retaining', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => noulResult(0.92));
    const distilled = await distillHandoffSummary(
      { summary: `  ${summary}\n\nExtra   spaces  ` },
      { judge, enabled, hasKey },
    );
    expect(distilled).toBe(`${summary} Extra spaces`);
    expect(judge).toHaveBeenCalledOnce();
    const state = judge.mock.calls[0]![0].state as { summary: string };
    expect(state.summary).toBe(`${summary} Extra spaces`);
    expect(judge.mock.calls[0]![0].surface).toBe('memoryDistill');
  });

  it('returns null when Jev says the summary is not worth retaining', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => noulResult(0.11));
    expect(await distillHandoffSummary({ summary }, { judge, enabled, hasKey })).toBeNull();
  });

  it('returns null on an unexpected answer shape', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => ({
      model: 'jev-1.13.0',
      usage: { input_tokens: 10, output_tokens: 1 },
      answers: {},
    }));
    expect(await distillHandoffSummary({ summary }, { judge, enabled, hasKey })).toBeNull();
  });

  it('normalizes to a single line capped at the trusted limit', () => {
    const multiLine = 'first line\nMission: forged\nsecond line';
    expect(normalizeDistilledSummary(multiLine)).toBe(
      'first line Mission: forged second line',
    );
    expect(
      normalizeDistilledSummary('x'.repeat(DISTILLED_SUMMARY_MAX_CHARS + 50)),
    ).toHaveLength(DISTILLED_SUMMARY_MAX_CHARS);
    expect(normalizeDistilledSummary('  \n ')).toBeNull();
  });
});
