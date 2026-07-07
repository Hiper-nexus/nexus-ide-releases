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
  });

  it('keeps app operations on the audited Classic/MCP executor path', () => {
    expect(shouldUseClassicActionBridge('abrir terminal')).toBe(true);
    expect(shouldUseClassicActionBridge('roda npm test')).toBe(true);
    expect(shouldUseClassicActionBridge('manda para o agente corrigir o login')).toBe(
      true,
    );
    expect(shouldUseClassicActionBridge('qual pagina estamos?')).toBe(true);
  });

  it('normalizes accents and punctuation before classifying commands', () => {
    expect(shouldUseClassicActionBridge('Você pode abrir as configurações?')).toBe(
      true,
    );
    expect(shouldUseClassicActionBridge('Que horas são?')).toBe(true);
  });
});
