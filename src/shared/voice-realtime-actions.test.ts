import { describe, expect, it } from 'vitest';
import {
  realtimeArgsToJarvisAction,
  summarizeNexusRealtimeAction,
} from './voice-realtime-actions';

describe('voice realtime squad selection actions', () => {
  it('keeps opening the saved-squad picker distinct from creating a squad', () => {
    expect(
      realtimeArgsToJarvisAction({ action: 'open_squad_picker' }),
    ).toEqual({ type: 'open_squad_picker' });
    expect(
      summarizeNexusRealtimeAction({ action: 'open_squad_picker' }),
    ).toBe('abrir seletor de squads salvos');
  });

  it('keeps repository sync as a direct operation instead of a mission action', () => {
    expect(realtimeArgsToJarvisAction({ action: 'sync_repository' })).toEqual({
      type: 'sync_repository',
    });
    expect(summarizeNexusRealtimeAction({ action: 'sync_repository' })).toBe(
      'sincronizar repositório local com origin',
    );
  });
});
