import { describe, expect, it } from 'vitest';
import { compileTextPatternPrefilter } from './required-text-hints';

describe('required literal hints preserve candidate matches', () => {
  it('keeps future unhinted Unicode patterns and original priority', () => {
    const patterns = [
      { re: /额度不足/, requiredTextHints: ['额度不足'] },
      { re: /账户已冻结/ },
      { re: /冻结/, requiredTextHints: [] },
    ];
    const candidates = compileTextPatternPrefilter(patterns);
    const first = (text: string) => candidates(text).find(pattern => pattern.re.test(text));
    expect(first('账户已冻结')).toBe(patterns[1]);
    expect(first('额度不足 账户已冻结')).toBe(patterns[0]);
    expect(first('é'.repeat(4000))).toBeUndefined();
  });

  it.each(['a+b', '[quota]', '(x)', 'x.y', '^x$', 'a|b', '\\path', '*?{}'])('escapes hint %s as literal text', hint => {
    const pattern = { requiredTextHints: [hint] };
    const candidates = compileTextPatternPrefilter([pattern]);
    expect(candidates(`before ${hint} after`)).toEqual([pattern]);
    expect(candidates('unrelated ordinary text')).toEqual([]);
  });

  it('case folding can over-admit but the original regexp still decides', () => {
    const pattern = { re: /Login expired/, requiredTextHints: ['Login expired'] };
    const candidates = compileTextPatternPrefilter([pattern]);
    expect(candidates('LOGIN EXPIRED')).toEqual([pattern]);
    expect(pattern.re.test('LOGIN EXPIRED')).toBe(false);
    expect(candidates('Login expired')).toEqual([pattern]);
    const unicodeFold = { re: /k/i, requiredTextHints: ['k'] };
    expect(compileTextPatternPrefilter([unicodeFold])('K')).toEqual([unicodeFold]);
    expect(unicodeFold.re.test('K')).toBe(false);
  });

  it('does not turn absent or empty hints into a blanket rejection', () => {
    const patterns = [{ re: /额度不足/ }, { re: /x/, requiredTextHints: [] }];
    expect(compileTextPatternPrefilter(patterns)('额度不足')).toEqual(patterns);
    const emptyLiteral = [{ re: /x/, requiredTextHints: [''] }];
    expect(compileTextPatternPrefilter(emptyLiteral)('x')).toEqual(emptyLiteral);
  });
});
