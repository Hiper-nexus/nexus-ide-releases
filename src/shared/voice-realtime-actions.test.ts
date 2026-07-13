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
});
