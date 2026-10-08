import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNexusHookText } from '../../vendor/emdash/hooks/hook-commands';
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
  it.each(['ephemeral-home', 'flag-settings'] as const)(
    'does not attribute concurrent checkout edits to this pane (%s)',
    (source) => {
      const file = source === 'ephemeral-home'
        ? path.join(prepareEphemeralHome(TOKEN, {}).dir, '.claude', 'settings.json')
        : writeClaudeFamilyZeroClickSettings(TOKEN);
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Bash snapshots observe every writer in the checkout, including a
      // sibling pane while this one merely waits for CI. Edit/Write diffs
      // remain native; only this unowned before/after attribution is disabled.
      expect(settings.bashEditDiffEnabled).toBe(false);
      expect(settings.hooks.PostToolUse).toBeDefined();
    },
  );

  it('skips the Bypass Permissions dialog in ephemeral HOME (gated GLM/Claude)', () => {
    const home = prepareEphemeralHome(TOKEN, { mcpServers: {} });
    const settingsPath = path.join(home.dir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      skipDangerousModePermissionPrompt?: boolean;
      skipWorkflowUsageWarning?: boolean;
      enabledPlugins?: Record<string, boolean>;
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.skipWorkflowUsageWarning).toBe(true);
    expect(settings.enabledPlugins).toEqual({});
    expect(settings.hooks).toBeTruthy();
    const profile = JSON.parse(
      fs.readFileSync(path.join(home.dir, '.claude.json'), 'utf8'),
    ) as {
      officialMarketplaceAutoInstallFailReason?: string;
      officialMarketplaceAutoInstallAttempted?: boolean;
    };
    expect(profile.officialMarketplaceAutoInstallAttempted).toBe(true);
    expect(profile.officialMarketplaceAutoInstallFailReason).toBe(
      'policy_blocked',
    );
    // Skill-gate enforcement hooks untouched (fail-closed .mjs with exit 2)…
    const gateCommands = JSON.stringify(settings.hooks ?? {});
    expect(gateCommands).toContain('nexus-gate.mjs');
    // …with the additive emdash status hooks merged alongside, never replacing.
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([
      'Notification',
      // F-965: settings por sessão dos panes do Nexus levam o broker de
      // aprovação estruturada; sem respondente o hook sai `{}` na hora e o
      // diálogo da TUI decide, então o zero-click não ganha clique novo.
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'Stop',
      // F-734: o turno que acaba em erro de API também chega ao Main.
      'StopFailure',
      'UserPromptSubmit',
    ]);
    // skill-gate + status + portão de regressão (/hook/regression).
    expect(settings.hooks?.Stop).toHaveLength(3);
    expect(JSON.stringify(settings.hooks?.PermissionRequest)).toContain('$NEXUS_HOOK_PERMISSION_URL');
    expect(isNexusHookText(gateCommands)).toBe(true);
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
      // F-965: settings por sessão dos panes do Nexus levam o broker de
      // aprovação estruturada; sem respondente o hook sai `{}` na hora e o
      // diálogo da TUI decide, então o zero-click não ganha clique novo.
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'Stop',
      // F-734: o turno que acaba em erro de API também chega ao Main.
      'StopFailure',
      'UserPromptSubmit',
    ]);
    const serialized = JSON.stringify(settings);
    expect(serialized).toContain('NEXUS_HOOK_STATUS');
    expect(serialized).toContain('$NEXUS_GATE_TOKEN');
    expect(serialized).not.toContain(TOKEN);
  });

  it('F-693: filtro de skills grava skillOverrides como MAPA — string invalida o settings.json inteiro', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skill-filter-'));
    try {
      for (const [dir, name] of [['typesafe-ai', 'typesafe-ai'], ['deploy-prod', 'Deploy Prod']] as const) {
        fs.mkdirSync(path.join(cwd, '.claude', 'skills', dir), { recursive: true });
        fs.writeFileSync(
          path.join(cwd, '.claude', 'skills', dir, 'SKILL.md'),
          `---\nname: ${name}\ndescription: x\n---\n`,
        );
      }
      const home = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
        skillFilter: ['typesafe-ai'],
        cwd,
      });
      const settings = JSON.parse(
        fs.readFileSync(path.join(home.dir, '.claude', 'settings.json'), 'utf8'),
      ) as { skillOverrides?: unknown; skipDangerousModePermissionPrompt?: boolean };
      // Claude 2.1.285: record<string, 'on'|'name-only'|'user-invocable-only'|'off'>.
      expect(typeof settings.skillOverrides).toBe('object');
      const overrides = settings.skillOverrides as Record<string, string>;
      expect(overrides['deploy-prod']).toBe('off');
      expect(overrides['Deploy Prod']).toBe('off');
      expect(overrides['typesafe-ai']).toBeUndefined();
      expect(Object.values(overrides).every((mode) => mode === 'off')).toBe(true);
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
