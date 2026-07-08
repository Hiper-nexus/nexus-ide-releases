import { describe, expect, it } from 'vitest';
import {
  shouldLetRealtimeProviderAnswer,
  shouldUseClassicActionBridge,
} from './realtime-bridge-policy';

describe('realtime bridge policy', () => {
  it('lets open conversation stay on the realtime provider audio path', () => {
    expect(shouldLetRealtimeProviderAnswer('como voce esta hoje?')).toBe(true);
    expect(shouldLetRealtimeProviderAnswer('me explica essa ideia em uma frase')).toBe(
      true,
    );
    expect(shouldLetRealtimeProviderAnswer('qual pagina estamos?')).toBe(true);
    expect(shouldLetRealtimeProviderAnswer('onde estamos no app?')).toBe(true);
  });

  it('keeps app operations on the audited Classic/MCP executor path when Live is down', () => {
    expect(shouldUseClassicActionBridge('abrir terminal')).toBe(true);
    expect(shouldUseClassicActionBridge('roda npm test')).toBe(true);
    expect(shouldUseClassicActionBridge('manda para o agente corrigir o login')).toBe(
      true,
    );
    expect(shouldUseClassicActionBridge('focus terminal')).toBe(true);
    expect(shouldUseClassicActionBridge('seleciona o browser')).toBe(true);
    expect(shouldUseClassicActionBridge('qual o status do git?')).toBe(true);
  });

  it('lets Live own app actions when realtime is hot (no Classic interrupt)', () => {
    expect(
      shouldLetRealtimeProviderAnswer('iniciar um novo squad', { isRealtimeLive: true }),
    ).toBe(true);
    expect(
      shouldLetRealtimeProviderAnswer('abrir terminal', { isRealtimeLive: true }),
    ).toBe(true);
    expect(shouldLetRealtimeProviderAnswer('iniciar um novo squad')).toBe(false);
  });

  it('normalizes accents and punctuation before classifying commands', () => {
    expect(shouldUseClassicActionBridge('Você pode abrir as configurações?')).toBe(
      true,
    );
    expect(shouldUseClassicActionBridge('Que horas são?')).toBe(true);
  });
});
