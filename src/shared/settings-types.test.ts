import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_ORCH_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  audioSettingsPatchSchema,
  audioSettingsSchema,
  orchSettingsSchema,
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
    expect(
      terminalSettingsSchema.safeParse({ shell: 'C:\\Program Files\\PowerShell\\pwsh.exe' })
        .success,
    ).toBe(true);
    expect(
      terminalSettingsSchema.safeParse({ shell: '\\\\server\\tools\\pwsh.exe' })
        .success,
    ).toBe(true);
    expect(terminalSettingsSchema.safeParse({ shell: 'zsh' }).success).toBe(false);
  });

  it('patch schema accepts partial updates without defaults bleeding in', () => {
    const patch = terminalSettingsPatchSchema.parse({ fontSize: 16 });
    expect(patch).toEqual({ fontSize: 16 });
  });
});

describe('audioSettingsSchema', () => {
  it('follows the system input and output by default', () => {
    expect(audioSettingsSchema.parse({})).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(DEFAULT_AUDIO_SETTINGS).toEqual({
      inputDeviceId: 'default',
      outputDeviceId: 'default',
    });
  });

  it('accepts opaque media device ids and rejects oversized values', () => {
    expect(
      audioSettingsSchema.safeParse({
        inputDeviceId: 'usb-mic-id',
        outputDeviceId: 'bluetooth-headset-id',
      }).success,
    ).toBe(true);
    expect(
      audioSettingsSchema.safeParse({ inputDeviceId: 'x'.repeat(513) }).success,
    ).toBe(false);
  });

  it('keeps audio patches partial', () => {
    expect(audioSettingsPatchSchema.parse({ outputDeviceId: 'headphones' })).toEqual({
      outputDeviceId: 'headphones',
    });
  });
});

describe('orchSettingsSchema', () => {
  it('has explicit provider, model and account defaults for the mission orchestrator', () => {
    expect(orchSettingsSchema.parse({})).toEqual(DEFAULT_ORCH_SETTINGS);
    expect(DEFAULT_ORCH_SETTINGS.defaultAdapterId).toBe('claude');
    expect(DEFAULT_ORCH_SETTINGS.defaultModel).toBe('');
    expect(DEFAULT_ORCH_SETTINGS.defaultAccountId).toBe('');
    // Multi-OS safe default: never silent-resume agents on layout restore.
    expect(DEFAULT_ORCH_SETTINGS.agentRestorePolicy).toBe('ask');
  });

  it('accepts agent restore policies used on every platform', () => {
    for (const policy of ['ask', 'pause', 'resume'] as const) {
      expect(
        orchSettingsSchema.safeParse({ agentRestorePolicy: policy }).success,
      ).toBe(true);
    }
    expect(
      orchSettingsSchema.safeParse({ agentRestorePolicy: 'yolo' }).success,
    ).toBe(false);
  });

  it('bounds opaque provider, model and account identifiers', () => {
    expect(
      orchSettingsSchema.safeParse({
        defaultAdapterId: 'codex',
        defaultModel: 'claude-opus-4-6',
        defaultAccountId: 'acct-work',
      }).success,
    ).toBe(true);
    expect(
      orchSettingsSchema.safeParse({ defaultAdapterId: 'x'.repeat(65) }).success,
    ).toBe(false);
    expect(
      orchSettingsSchema.safeParse({ defaultAccountId: 'x'.repeat(129) }).success,
    ).toBe(false);
  });
});
