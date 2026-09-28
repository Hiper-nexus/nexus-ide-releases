import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../jev/jev-client';
import { prepareBrowserFocus, resolveBrowserFocus } from './browser-focused-context';

const text = 'Introdução irrelevante. '.repeat(100) + 'A resposta está na última seção. '.repeat(100);
const answers = (ids: string[], selected: string[]) => Object.fromEntries(ids.map(id => [id, { type: 'noul', noul: selected.includes(id) ? 0.95 : 0.05 }])) as Record<string, JevAnswer>;

describe('focused browser source selection', () => {
  it('covers the whole read, including its tail, and returns only source excerpts', () => {
    const plan = prepareBrowserFocus(text, 'Onde está a resposta?')!;
    expect(plan.state.passages.map(p => p.text).join('')).toBe(text);
    expect(plan.state.passages.length).toBeLessThanOrEqual(12);
    const key = Object.keys(plan.questions).at(-1)!;
    const result = resolveBrowserFocus(plan, answers(Object.keys(plan.questions), [key]));
    expect(result.text).toBe(plan.state.passages.at(-1)!.text);
    expect(result.selection.applied).toBe(true);
    expect(result.selection.afterBytes).toBeLessThan(result.selection.beforeBytes);
  });

  it('preserves full context on low confidence, malformed/incomplete answers, or no reduction', () => {
    const plan = prepareBrowserFocus(text, 'Explique')!;
    const keys = Object.keys(plan.questions);
    for (const response of [answers(keys, []), {}, answers(keys, keys), { ...answers(keys, []), [keys[0]]: { type: 'noul', noul: NaN } }]) {
      const result = resolveBrowserFocus(plan, response as Record<string, JevAnswer>);
      expect(result.text).toBe(text);
      expect(result.selection.applied).toBe(false);
    }
  });

  it('does not ask the model to filter tiny or incompletely covered inputs', () => {
    expect(prepareBrowserFocus('tiny page', 'question')).toBeNull();
    expect(prepareBrowserFocus(text, ' ')).toBeNull();
    expect(prepareBrowserFocus('x'.repeat(20_001), 'question')).toBeNull();
  });

  it('keeps Unicode pairs intact at passage boundaries', () => {
    const original = 'Á 🌙 contexto '.repeat(400);
    const plan = prepareBrowserFocus(original, 'contexto')!;
    expect(plan.state.passages.map(p => p.text).join('')).toBe(original);
    expect(plan.state.passages.some(p => /[\uD800-\uDBFF]$/.test(p.text))).toBe(false);
  });
});
