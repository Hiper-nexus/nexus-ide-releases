import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.skipWorkflowUsageWarning).toBe(true);
    expect(settings.hooks).toBeTruthy();
    // Skill-gate enforcement hooks untouched (fail-closed .mjs with exit 2)…
    const gateCommands = JSON.stringify(settings.hooks ?? {});
    expect(gateCommands).toContain('nexus-gate.mjs');
    // …with the additive emdash status hooks merged alongside, never replacing.
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PreToolUse',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(settings.hooks?.Stop).toHaveLength(2);
    expect(gateCommands).toContain('NEXUS_HOOK_STATUS');
    expect(home.dir.startsWith(path.join(os.homedir(), '.nexus', 'ephemeral'))).toBe(
      true,
    );
  });

  it('writes the same zero-click flag settings for ungated real-HOME panes', () => {
    const file = writeClaudeFamilyZeroClickSettings(TOKEN);
    expect(file.endsWith('.settings.json')).toBe(true);
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      skipDangerousModePermissionPrompt?: boolean;
      skipWorkflowUsageWarning?: boolean;
      hooks?: Record<string, unknown[]>;
    };
    // Zero-click keys unchanged; the additive emdash status hooks ride along
    // (marker-separated, env-only auth — no token literal in the file).
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.skipWorkflowUsageWarning).toBe(true);
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([
      'Notification',
      'Stop',
      'UserPromptSubmit',
    ]);
    const serialized = JSON.stringify(settings);
    expect(serialized).toContain('NEXUS_HOOK_STATUS');
    expect(serialized).toContain('$NEXUS_GATE_TOKEN');
    expect(serialized).not.toContain(TOKEN);
  });
});
