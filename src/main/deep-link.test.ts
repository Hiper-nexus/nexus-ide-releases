import { describe, expect, it } from 'vitest';
import { parseDeepLink, deepLinkFromArgv } from './deep-link';

describe('parseDeepLink', () => {
  it('reconhece nexus://license/<token>', () => {
    const r = parseDeepLink('nexus://license/abc.def.ghi');
    expect(r).toEqual({ kind: 'license', token: 'abc.def.ghi' });
  });

  it('license aceita token na query também', () => {
    expect(parseDeepLink('nexus://license?token=xyz')).toEqual({
      kind: 'license',
      token: 'xyz',
    });
  });

  it('reconhece nexus://open?path=<abs> só com caminho absoluto', () => {
    expect(parseDeepLink('nexus://open?path=%2FUsers%2Fme%2Fp')).toEqual({
      kind: 'open',
      path: '/Users/me/p',
    });
    // caminho relativo é rejeitado (anti path-traversal / surpresa)
    expect(parseDeepLink('nexus://open?path=../etc')).toBeNull();
  });

  it('rejeita esquema errado, host desconhecido e token perigoso', () => {
    expect(parseDeepLink('https://license/x')).toBeNull();
    expect(parseDeepLink('nexus://desconhecido/x')).toBeNull();
    expect(parseDeepLink('nexus://license/')).toBeNull();
    // token com caracteres fora do conjunto seguro
    expect(parseDeepLink('nexus://license/a b<c')).toBeNull();
    expect(parseDeepLink('lixo')).toBeNull();
  });

  it('limita o tamanho do token', () => {
    expect(parseDeepLink('nexus://license/' + 'a'.repeat(5000))).toBeNull();
  });

  it('reconhece nexus://auth/<code> com code seguro', () => {
    expect(parseDeepLink('nexus://auth/abcXYZ_-.09')).toEqual({
      kind: 'auth',
      code: 'abcXYZ_-.09',
      state: null,
    });
    expect(parseDeepLink('nexus://auth/')).toBeNull();
    expect(parseDeepLink('nexus://auth/tem espaço')).toBeNull();
    expect(parseDeepLink('nexus://auth/' + 'a'.repeat(5000))).toBeNull();
  });

  it('sequência malformada no path NÃO lança — vira link inválido (null)', () => {
    expect(() => parseDeepLink('nexus://license/%E0%A4%A')).not.toThrow();
    expect(parseDeepLink('nexus://license/%E0%A4%A')).toBeNull();
    expect(() => parseDeepLink('nexus://auth/%E0%A4%A')).not.toThrow();
    expect(parseDeepLink('nexus://auth/%E0%A4%A')).toBeNull();
    // token na query continua válido mesmo com path quebrado
    expect(parseDeepLink('nexus://license/%E0%A4%A?token=tok')).toEqual({
      kind: 'license',
      token: 'tok',
    });
  });

  it('auth carrega o ?state= do binding local (e rejeita state perigoso)', () => {
    expect(parseDeepLink('nexus://auth/code1?state=nonce-1')).toEqual({
      kind: 'auth',
      code: 'code1',
      state: 'nonce-1',
    });
    // state fora do conjunto seguro invalida o link inteiro
    expect(parseDeepLink('nexus://auth/code1?state=tem espaço')).toBeNull();
    expect(parseDeepLink('nexus://auth/code1?state=' + 'a'.repeat(5000))).toBeNull();
  });
});

describe('deepLinkFromArgv', () => {
  it('acha o primeiro argumento nexus://', () => {
    const r = deepLinkFromArgv([
      '/Applications/NexusIDE.app',
      '--flag',
      'nexus://license/tok',
    ]);
    expect(r).toEqual({ kind: 'license', token: 'tok' });
  });

  it('nenhum argumento nexus:// → null', () => {
    expect(deepLinkFromArgv(['/app', '--x'])).toBeNull();
  });
});
