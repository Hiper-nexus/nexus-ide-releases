import { describe, expect, it } from 'vitest';
import { MISSION_PICK_LIMITS, missionPickRequestSchema } from './mission-pick';

const candidate = (title: string) => ({ title, state: 'running', updatedAt: 1_700_000_000_000 });
const valid = {
  spoken: 'site da loja',
  candidates: [candidate('Site da loja'), candidate('Site da loja v2')],
};

describe('missionPickRequestSchema', () => {
  it('accepts what the renderer sends: the spoken name and 2 to 5 candidates', () => {
    expect(missionPickRequestSchema.safeParse(valid).success).toBe(true);
    const five = { ...valid, candidates: Array.from({ length: 5 }, (_, i) => candidate(`Loja ${i}`)) };
    expect(missionPickRequestSchema.safeParse(five).success).toBe(true);
  });

  it('keeps the last-activity time optional', () => {
    const noTime = { spoken: 'loja', candidates: [{ title: 'A', state: 'running' }, { title: 'B', state: 'completed' }] };
    expect(missionPickRequestSchema.safeParse(noTime).success).toBe(true);
  });

  it.each([
    ['not an object', 'oi'],
    ['null', null],
    ['an unknown top-level key', { ...valid, extra: true }],
    ['a real mission id riding along', { ...valid, candidates: [{ ...candidate('A'), id: 'mission-123' }, candidate('B')] }],
    ['a path riding along', { ...valid, candidates: [{ ...candidate('A'), path: '/Users/ana/loja' }, candidate('B')] }],
    ['a single candidate (nothing to choose from)', { ...valid, candidates: [candidate('A')] }],
    ['more than five candidates', { ...valid, candidates: Array.from({ length: 6 }, (_, i) => candidate(`L${i}`)) }],
    ['an empty spoken name', { ...valid, spoken: '   ' }],
    ['a spoken name over the limit', { ...valid, spoken: 'a'.repeat(MISSION_PICK_LIMITS.spokenMax + 1) }],
    ['a title over the limit', { ...valid, candidates: [candidate('t'.repeat(MISSION_PICK_LIMITS.titleMax + 1)), candidate('B')] }],
    ['an empty title', { ...valid, candidates: [candidate(' '), candidate('B')] }],
    ['a status that is not a plain label', { ...valid, candidates: [{ title: 'A', state: 'Running now!' }, candidate('B')] }],
    ['a non-integer timestamp', { ...valid, candidates: [{ title: 'A', state: 'running', updatedAt: 1.5 }, candidate('B')] }],
  ])('refuses %s', (_label, payload) => {
    expect(missionPickRequestSchema.safeParse(payload).success).toBe(false);
  });
});
