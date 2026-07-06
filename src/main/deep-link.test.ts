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
