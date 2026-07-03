import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_SETTINGS,
  terminalSettingsPatchSchema,
  terminalSettingsSchema,
} from './settings-types';

describe('terminalSettingsSchema', () => {
  it('parses an empty object into full defaults', () => {
    expect(terminalSettingsSchema.parse({})).toEqual(
      DEFAULT_TERMINAL_SETTINGS,
    );
    expect(DEFAULT_TERMINAL_SETTINGS.themeId).toBe('nexus-dark');
    expect(DEFAULT_TERMINAL_SETTINGS.fontSize).toBe(13);
  });

  it('rejects unknown theme ids', () => {
    expect(
      terminalSettingsSchema.safeParse({ themeId: 'hotdog-stand' }).success,
    ).toBe(false);
  });

  it('bounds the font size to 9-24', () => {
    expect(terminalSettingsSchema.safeParse({ fontSize: 8 }).success).toBe(false);
    expect(terminalSettingsSchema.safeParse({ fontSize: 25 }).success).toBe(false);
    expect(terminalSettingsSchema.safeParse({ fontSize: 14 }).success).toBe(true);
  });

  it('accepts an empty shell (default) or an absolute path only', () => {
    expect(terminalSettingsSchema.safeParse({ shell: '' }).success).toBe(true);
    expect(terminalSettingsSchema.safeParse({ shell: '/bin/bash' }).success).toBe(true);
    expect(terminalSettingsSchema.safeParse({ shell: 'zsh' }).success).toBe(false);
  });

  it('patch schema accepts partial updates without defaults bleeding in', () => {
    const patch = terminalSettingsPatchSchema.parse({ fontSize: 16 });
    expect(patch).toEqual({ fontSize: 16 });
  });
});
