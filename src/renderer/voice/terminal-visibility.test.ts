import { describe, expect, it } from 'vitest';
import {
  assessTerminalVisibility,
  listBlockingOverlayLabels,
  type BlockingOverlayFlags,
  type UiVisibilityState,
} from './terminal-visibility';

const NO_OVERLAYS: BlockingOverlayFlags = {
  operatorProfile: false,
  homeDeck: false,
  settingsDrawer: false,
  voiceSettings: false,
  missionWizard: false,
  opsBoard: false,
  onboarding: false,
  closeWorkspaceDialog: false,
  orchPanel: false,
  filesPanel: false,
};

function baseState(overrides: Partial<UiVisibilityState> = {}): UiVisibilityState {
  return {
    workspaceOpen: true,
    viewKind: 'grid',
    focusedPaneId: 'shell-1',
    focusedPaneKind: 'shell',
    shellPaneIds: ['shell-1'],
    overlays: { ...NO_OVERLAYS },
    ...overrides,
  };
}

describe('assessTerminalVisibility', () => {
  it('marca visível quando grade, foco shell e sem overlays', () => {
    expect(assessTerminalVisibility('shell-1', baseState(), true)).toEqual({
      visible: true,
      reasons: [],
    });
  });

  it('falha quando perfil operador cobre a tela', () => {
    const result = assessTerminalVisibility(
      'shell-1',
      baseState({
        overlays: { ...NO_OVERLAYS, operatorProfile: true },
      }),
      true,
    );
    expect(result.visible).toBe(false);
    expect(result.reasons.some((r) => r.includes('perfil operador'))).toBe(true);
  });

  it('falha quando home deck cobre terminal existente', () => {
    const result = assessTerminalVisibility(
      'shell-1',
      baseState({
        overlays: { ...NO_OVERLAYS, homeDeck: true },
      }),
      true,
    );
    expect(result.visible).toBe(false);
    expect(result.reasons.some((r) => r.includes('home deck'))).toBe(true);
  });

  it('falha em canvas mesmo com sessão PTY', () => {
    const result = assessTerminalVisibility(
      'shell-1',
      baseState({ viewKind: 'canvas' }),
      true,
    );
    expect(result.visible).toBe(false);
    expect(result.reasons.some((r) => r.includes('canvas'))).toBe(true);
  });

  it('lista overlays bloqueantes para contexto de tela', () => {
    expect(
      listBlockingOverlayLabels({
        ...NO_OVERLAYS,
        operatorProfile: true,
        homeDeck: true,
      }),
    ).toEqual(['perfil operador', 'home deck']);
  });
});
