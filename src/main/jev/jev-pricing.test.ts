import { describe, expect, it } from 'vitest';
import { USD_PER_INPUT_TOKEN } from './jev-pricing';

describe('jev-pricing', () => {
  it('fixa o preço público da TypeSafe: US$ 0,042 por milhão de tokens de entrada', () => {
    expect(USD_PER_INPUT_TOKEN).toBe(0.042 / 1e6);
  });
});
