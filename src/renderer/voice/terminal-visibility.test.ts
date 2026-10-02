import { describe, expect, it } from 'vitest';
import type { ProductDestination } from '../state/product-navigation-store';
import { useBugReportDialogStore } from '../state/bug-report-dialog-store';
import {
  assessTerminalVisibility,
  listBlockingOverlayLabels,
  readUiVisibilityState,
  type BlockingOverlayFlags,
  type UiVisibilityState,
} from './terminal-visibility';

const NO_MOUNTED_OVERLAYS = {
  operatorProfile: false,
  voiceSettings: false,
  closeWorkspaceDialog: false,
  orchestrationMode: false,
  mediaStudio: false,
  commandPalette: false,
  confirmation: false,
  keyboardCheatsheet: false,
} as unknown as BlockingOverlayFlags;

function baseState(
  destination: ProductDestination,
  overrides: Partial<UiVisibilityState> = {},
): UiVisibilityState {
  return {
    workspaceOpen: true,
    destination,
    focusedPaneId: 'shell-1',
    focusedPaneKind: 'shell',
    shellPaneIds: ['shell-1'],
    overlays: { ...NO_MOUNTED_OVERLAYS },
    ...overrides,
  } as UiVisibilityState;
}

describe('terminal visibility follows mounted product surfaces', () => {
  it.each([
    ['Launcher', { kind: 'launcher' }],
    ['Mission Setup', { kind: 'mission-setup' }],
    [
      'Mission Board',
      { kind: 'mission', missionId: 'mission-a', surface: 'board' },
    ],
    ['Task Board', { kind: 'task-board' }],
    ['Memory', { kind: 'memory' }],
    ['Settings', { kind: 'settings', section: 'providers' }],
  ] as const)('does not report a hidden terminal through %s', (_label, destination) => {
    const result = assessTerminalVisibility(
      'shell-1',
      baseState(destination),
      true,
    );

    expect(result.visible).toBe(false);
    expect(result.reasons.some((reason) => /destino|destination|surface/i.test(reason)))
      .toBe(true);
  });

  it.each([
    ['standalone Terminal', { kind: 'terminal' }],
    [
      'Mission Terminals',
      { kind: 'mission', missionId: 'mission-a', surface: 'terminals' },
    ],
  ] as const)('reports a ready focused terminal on %s', (_label, destination) => {
    expect(
      assessTerminalVisibility('shell-1', baseState(destination), true),
    ).toEqual({
      visible: true,
      reasons: [],
    });
  });

  it('reports a mounted blocking overlay instead of the terminal beneath it', () => {
    const overlays = {
      ...NO_MOUNTED_OVERLAYS,
      operatorProfile: true,
    } as BlockingOverlayFlags;
    const result = assessTerminalVisibility(
      'shell-1',
      baseState({ kind: 'terminal' }, { overlays }),
      true,
    );

    expect(result.visible).toBe(false);
    expect(listBlockingOverlayLabels(overlays)).toContain('perfil operador');
    expect(result.reasons).toContain('overlay: perfil operador');
  });

  it('reports the bug report dialog as a blocking overlay and reads it from its store', () => {
    const overlays = {
      ...NO_MOUNTED_OVERLAYS,
      bugReport: true,
    } as BlockingOverlayFlags;
    expect(listBlockingOverlayLabels(overlays)).toContain('reportar um problema');
    expect(
      assessTerminalVisibility('shell-1', baseState({ kind: 'terminal' }, { overlays }), true).reasons,
    ).toContain('overlay: reportar um problema');

    useBugReportDialogStore.setState({ isOpen: true });
    try {
      expect(readUiVisibilityState().overlays.bugReport).toBe(true);
    } finally {
      useBugReportDialogStore.setState({ isOpen: false });
    }
    expect(readUiVisibilityState().overlays.bugReport).toBe(false);
  });

  it('still rejects an unfocused pane on a terminal-bearing destination', () => {
    const result = assessTerminalVisibility(
      'shell-1',
      baseState(
        { kind: 'terminal' },
        { focusedPaneId: 'shell-other' },
      ),
      true,
    );

    expect(result.visible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sem foco/),
      ]),
    );
  });
});
