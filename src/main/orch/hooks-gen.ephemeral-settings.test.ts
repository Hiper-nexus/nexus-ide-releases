import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_FAMILY_ZERO_CLICK_SETTINGS,
  cleanupSessionArtifacts,
  prepareEphemeralHome,
  writeClaudeFamilyZeroClickSettings,
} from './hooks-gen';

const TOKEN = `ephemeral-settings-test-${process.pid}-${Date.now()}`;

afterEach(() => {
  cleanupSessionArtifacts(TOKEN);
});

describe('Claude-family zero-click settings (system default)', () => {
  it('skips the Bypass Permissions dialog in ephemeral HOME (gated GLM/Claude)', () => {
    const home = prepareEphemeralHome(TOKEN, { mcpServers: {} });
    const settingsPath = path.join(home.dir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      skipDangerousModePermissionPrompt?: boolean;
      skipWorkflowUsageWarning?: boolean;
      hooks?: unknown;
    };
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.skipWorkflowUsageWarning).toBe(true);
    expect(settings.hooks).toBeTruthy();
    expect(home.dir.startsWith(path.join(os.homedir(), '.nexus', 'ephemeral'))).toBe(
      true,
    );
  });

  it('writes the same zero-click flag settings for ungated real-HOME panes', () => {
    const file = writeClaudeFamilyZeroClickSettings(TOKEN);
    expect(file.endsWith('.settings.json')).toBe(true);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings).toEqual({ ...CLAUDE_FAMILY_ZERO_CLICK_SETTINGS });
  });
});
