import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_ACTIONS,
  launcherActionIdForKey,
  launcherShortcutHint,
  requireAccessibleName,
} from './action-names';

describe('action names + launcher shortcuts (T3)', () => {
  it('every launcher action has a stable id, label and accessible name', () => {
    for (const entry of LAUNCHER_ACTIONS) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(requireAccessibleName(entry)).toBe(entry.accessibleName);
    }
  });

  it('accessible names are unique', () => {
    const names = LAUNCHER_ACTIONS.map((a) => a.accessibleName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('shortcuts 1-6 are unique and map to the action id', () => {
    const shortcuts = LAUNCHER_ACTIONS.map((a) => a.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(launcherActionIdForKey('1')).toBe('pane');
    expect(launcherActionIdForKey('2')).toBe('mission');
    expect(launcherActionIdForKey('6')).toBe('memory');
    expect(launcherActionIdForKey('9')).toBeNull();
  });

  it('shortcuts never fire while typing in an editable target', () => {
    expect(
      launcherActionIdForKey('1', { targetIsEditable: true }),
    ).toBeNull();
  });

  it('icon-only action without accessible name is rejected', () => {
    expect(() =>
      requireAccessibleName({ id: 'ghost', accessibleName: '  ', label: '' }),
    ).toThrow(/no accessible name/);
  });

  it('falls back to label when accessibleName is missing', () => {
    expect(
      requireAccessibleName({ id: 'x', label: 'Abrir' }),
    ).toBe('Abrir');
  });

  it('shortcut hint is exposed for each action', () => {
    expect(launcherShortcutHint('pane')).toBe('1');
    expect(launcherShortcutHint('nope')).toBeNull();
  });
});
