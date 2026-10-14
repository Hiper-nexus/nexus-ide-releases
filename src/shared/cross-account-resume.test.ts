import { describe, expect, it } from 'vitest';
import { nativeResumeAcrossAccounts } from './cross-account-resume';

const claude = (upstream = 'anthropic') => ({ adapterId: 'claude', upstream });

describe('nativeResumeAcrossAccounts (F-1473)', () => {
  it('Claude: o histórico por checkout atravessa as contas Anthropic do mesmo adapter', () => {
    expect(nativeResumeAcrossAccounts('claude')).toBe(true);
    expect(nativeResumeAcrossAccounts('claude', { from: claude(), to: claude() })).toBe(true);
    // Login nativo (sem conta) → conta do vault.
    expect(nativeResumeAcrossAccounts('claude', { from: null, to: claude() })).toBe(true);
  });

  it('CLI que isola o histórico por conta ou não provada continua com o pacote', () => {
    for (const adapterId of ['agy', 'codex', 'devin', 'kimi', 'grok', 'mimo-code', 'constructor', '__proto__']) {
      expect(nativeResumeAcrossAccounts(adapterId)).toBe(false);
    }
  });

  it('adapters diferentes ou upstream de terceiro nunca reaproveitam a conversa', () => {
    expect(nativeResumeAcrossAccounts('claude', { from: claude(), to: { adapterId: 'codex', upstream: 'anthropic' } })).toBe(false);
    expect(nativeResumeAcrossAccounts('claude', { from: { adapterId: 'codex' }, to: claude() })).toBe(false);
    expect(nativeResumeAcrossAccounts('claude', { from: claude(), to: claude('glm') })).toBe(false);
    expect(nativeResumeAcrossAccounts('claude', { from: claude('sakana'), to: claude() })).toBe(false);
  });

  it('desligado: comportamento anterior (sessão nova + pacote)', () => {
    expect(nativeResumeAcrossAccounts('claude', { from: claude(), to: claude() }, false)).toBe(false);
  });
});
