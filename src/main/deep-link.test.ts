import { describe, expect, it } from 'vitest';
import { parseDeepLink, deepLinkFromArgv, shouldClaimDeepLinkScheme } from './deep-link';

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

  it('reconhece nexus://quota (Redline → Uso e cotas)', () => {
    expect(parseDeepLink('nexus://quota')).toEqual({ kind: 'quota' });
    expect(parseDeepLink('nexus://quota/')).toEqual({ kind: 'quota' });
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

  it('reconhece nexus://new e nexus://new?prompt= (formulário, nunca auto-start)', () => {
    expect(parseDeepLink('nexus://new')).toEqual({ kind: 'new', prompt: null });
    expect(parseDeepLink('nexus://new/')).toEqual({ kind: 'new', prompt: null });
    expect(parseDeepLink('nexus://new?prompt=Corrigir%20o%20login')).toEqual({
      kind: 'new',
      prompt: 'Corrigir o login',
    });
  });

  it('nexus://new aceita multi-linha e recusa só-invisíveis ou acima do teto', () => {
    expect(parseDeepLink('nexus://new?prompt=linha1%0Alinha2')).toEqual({
      kind: 'new',
      prompt: 'linha1\nlinha2',
    });
    expect(parseDeepLink('nexus://new?prompt=' + 'a'.repeat(20_000))).toBeNull();
    // zero-width: o link inteiro cai (só invisíveis = malicioso)
    expect(parseDeepLink('nexus://new?prompt=%E2%80%8B%E2%80%8B')).toBeNull();
    // invisíveis no meio do texto saem, o pedido continua
    expect(parseDeepLink('nexus://new?prompt=ok%E2%80%8Bfim')).toEqual({
      kind: 'new',
      prompt: 'okfim',
    });
    // UTF-8 comum (inclusive emoji) é texto válido
    expect(parseDeepLink('nexus://new?prompt=missão%20🚀')).toEqual({
      kind: 'new',
      prompt: 'missão 🚀',
    });
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

/**
 * F-1627: o dev roubava o `nexus://` do app instalado e o entregava a um
 * bundle que não declara o esquema — o link morria em silêncio e o login
 * «não pegava». Provado em 21/10/2026 com `open nexus://quota`.
 */
describe('shouldClaimDeepLinkScheme', () => {
  it('empacotado SEMPRE reivindica, em qualquer plataforma', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(shouldClaimDeepLinkScheme({ isDev: false, platform })).toBe(true);
    }
  });

  it('dev no macOS NÃO reivindica — reivindicar faria o link sumir', () => {
    expect(shouldClaimDeepLinkScheme({ isDev: true, platform: 'darwin' })).toBe(false);
  });

  it('dev no Windows e no Linux segue reivindicando (lá o registro funciona)', () => {
    expect(shouldClaimDeepLinkScheme({ isDev: true, platform: 'win32' })).toBe(true);
    expect(shouldClaimDeepLinkScheme({ isDev: true, platform: 'linux' })).toBe(true);
  });

  // Revisão do PR #153 (P2): uma saída por variável de ambiente seria uma
  // ARMADILHA. Reivindicar em dev no macOS é exatamente o que quebra a
  // entrega — o bundle de dev não declara CFBundleURLTypes —, então o
  // "escape hatch" reproduziria o bug em vez de contorná-lo. Não existe.
  it('não há saída por variável: nada reivindica em dev no macOS', () => {
    const extra = { NEXUS_DEV_CLAIM_DEEP_LINK: '1' } as Record<string, string>;
    expect(extra.NEXUS_DEV_CLAIM_DEEP_LINK).toBe('1');
    expect(shouldClaimDeepLinkScheme({ isDev: true, platform: 'darwin' })).toBe(false);
  });
});
