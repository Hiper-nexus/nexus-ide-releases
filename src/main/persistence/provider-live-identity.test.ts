import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetLiveIdentity,
  liveIdentityAccountId,
  liveIdentityAnchor,
  noteLiveIdentity,
} from './provider-live-identity';

beforeEach(() => forgetLiveIdentity());

describe('identidade viva por adapter', () => {
  it('sem spawn não há identidade', () => {
    expect(liveIdentityAccountId('agy')).toBeNull();
  });

  it('o último spawn manda', () => {
    noteLiveIdentity('agy', 'a');
    noteLiveIdentity('agy', 'b');
    expect(liveIdentityAccountId('agy')).toBe('b');
  });

  it('cada adapter tem a sua', () => {
    noteLiveIdentity('agy', 'a');
    noteLiveIdentity('claude', 'c');
    expect(liveIdentityAccountId('agy')).toBe('a');
    expect(liveIdentityAccountId('claude')).toBe('c');
  });

  it('forgetLiveIdentity zera tudo', () => {
    noteLiveIdentity('agy', 'a');
    forgetLiveIdentity();
    expect(liveIdentityAccountId('agy')).toBeNull();
  });
});

describe('âncora de seleção: só provedores de vaga única', () => {
  it('AGY usa a identidade selada como âncora', () => {
    noteLiveIdentity('agy', 'a');
    expect(liveIdentityAnchor('agy')).toBe('a');
  });

  it('Claude NÃO usa: cada conta tem perfil próprio, a âncora segue sendo a do store', () => {
    noteLiveIdentity('claude', 'b');
    expect(liveIdentityAnchor('claude')).toBeNull();
  });

  it('Codex também não', () => {
    noteLiveIdentity('codex', 'c');
    expect(liveIdentityAnchor('codex')).toBeNull();
  });
});
