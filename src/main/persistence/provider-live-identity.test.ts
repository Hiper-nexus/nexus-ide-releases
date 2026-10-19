import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetLiveIdentity,
  liveIdentityAccountId,
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
