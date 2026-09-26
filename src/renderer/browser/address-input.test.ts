import { describe, expect, it } from 'vitest';
import { browserAddressInput } from './address-input';

describe('browser address input', () => {
  it.each([
    ['coolify', 'https://www.google.com/search?q=coolify'],
    ['  como instalar coolify  ', 'https://www.google.com/search?q=como%20instalar%20coolify'],
    ['café & pão', 'https://www.google.com/search?q=caf%C3%A9%20%26%20p%C3%A3o'],
    ['https://example.com/a?q=b', 'https://example.com/a?q=b'],
    ['example.com/path', 'https://example.com/path'],
    ['localhost:5173', 'http://localhost:5173'],
    ['127.0.0.1:3000/a', 'http://127.0.0.1:3000/a'],
    ['[::1]:3000', 'http://[::1]:3000'],
    ['about:blank', 'about:blank'],
  ])('resolves %s as a search or address', (input, expected) => {
    expect(browserAddressInput(input)).toBe(expected);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test'])('rejects unsafe scheme %s instead of searching it', (input) => {
    expect(() => browserAddressInput(input)).toThrow();
  });
});
