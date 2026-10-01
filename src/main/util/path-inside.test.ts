import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStrictlyInside } from './path-inside';

describe('isStrictlyInside (F-716)', () => {
  const root = path.resolve('profiles', 'operator');

  it('aceita o que mora dentro da raiz, em qualquer profundidade', () => {
    expect(isStrictlyInside(root, path.join(root, 'auth.json'))).toBe(true);
    expect(isStrictlyInside(root, path.join(root, 'config', 'mcp_config.json'))).toBe(true);
    expect(isStrictlyInside(root + path.sep, path.join(root, 'auth.json'))).toBe(true);
  });

  it('recusa a própria raiz, a irmã com o mesmo prefixo e o que escapa por ..', () => {
    expect(isStrictlyInside(root, root)).toBe(false);
    expect(isStrictlyInside(root, root + path.sep)).toBe(false);
    expect(isStrictlyInside(root, `${root}2`)).toBe(false);
    expect(isStrictlyInside(root, path.join(`${root}2`, 'auth.json'))).toBe(false);
    expect(isStrictlyInside(root, path.join(root, '..', 'foreign.txt'))).toBe(false);
    expect(isStrictlyInside(root, path.dirname(root))).toBe(false);
  });

  it('um nome que só começa com ".." continua dentro', () => {
    expect(isStrictlyInside(root, path.join(root, '..cache', 'x'))).toBe(true);
  });
});
