import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNexusHookText } from '../../vendor/emdash/hooks/hook-commands';
import { execFileSync } from 'node:child_process';
import {
  cleanupSessionArtifacts,
  hookCommand,
  NEXUS_HANDOFF_SUBMIT_HOOK_MATCHER,
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
    // F-795/F-1154: o hook de entrega do handoff (spool) segue no PreToolUse…
    const gateCommands = JSON.stringify(settings.hooks ?? {});
    expect(gateCommands).toContain('nexus-gate.mjs');
    // …with the additive emdash status hooks merged alongside, never replacing.
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([
      'Notification',
      // F-991: settings por sessão dos panes do Nexus levam o broker de
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
    // status + portão de regressão (/hook/regression); o Stop do gate saiu (F-1154).
    expect(settings.hooks?.Stop).toHaveLength(2);
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
      // F-991: settings por sessão dos panes do Nexus levam o broker de
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

  it('F-1157: no skill is hidden from the agent — no skillOverrides, native skills linked', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skill-open-'));
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'deploy-prod'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'deploy-prod', 'SKILL.md'), '---\nname: Deploy Prod\n---\n');
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, { inheritNativeProfile: true });
      const settings = JSON.parse(
        fs.readFileSync(path.join(overlay.dir, '.claude', 'settings.json'), 'utf8'),
      ) as { skillOverrides?: unknown; skipDangerousModePermissionPrompt?: boolean };
      expect(settings.skillOverrides).toBeUndefined();
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(fs.existsSync(path.join(overlay.dir, '.claude', 'skills', 'deploy-prod', 'SKILL.md'))).toBe(true);
      cleanupSessionArtifacts(TOKEN);
    } finally {
      homedir.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('F-1154: no Nexus hook on every tool call', () => {
  const settingsOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  };
  const gateEntries = (dir: string, event: string) =>
    (settingsOf(dir).hooks[event] ?? []).filter((entry) =>
      (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes('nexus-gate.mjs')));

  it('registers the handoff hook only for nexus_handoff_submit, never on PostToolUse or Stop', () => {
    const dir = prepareEphemeralHome(TOKEN, {}).dir;
    const [pre, ...rest] = gateEntries(dir, 'PreToolUse');
    expect(rest).toHaveLength(0);
    expect(pre!.matcher).toBe(NEXUS_HANDOFF_SUBMIT_HOOK_MATCHER);
    expect(gateEntries(dir, 'PostToolUse')).toHaveLength(0);
    expect(gateEntries(dir, 'Stop')).toHaveLength(0);
    // Claude Code tests a non-literal matcher as an unanchored JS regex against tool_name.
    const matcher = new RegExp(pre!.matcher!);
    for (const tool of ['mcp__nexus__nexus_handoff_submit', 'mcp__nexus_dev__nexus_handoff_submit']) {
      expect(matcher.test(tool), tool).toBe(true);
    }
    for (const tool of ['Bash', 'Read', 'Edit', 'WebFetch', 'mcp__nexus__nexus_handoff_list', 'mcp__nexus__nexus_pane_spawn', 'mcp__other__nexus_handoff_submit']) {
      expect(matcher.test(tool), tool).toBe(false);
    }
    if (process.platform !== 'win32') {
      expect(pre!.hooks![0]!.command).toMatch(/^NODE_OPTIONS= node "[^"]+nexus-gate\.mjs" pretool$/);
    }
    expect(hookCommand('/x/nexus-gate.mjs', 'pretool', 'win32')).toBe('node "/x/nexus-gate.mjs" pretool');
    expect(hookCommand('/x/nexus-gate.mjs', 'pretool', 'darwin')).toBe('NODE_OPTIONS= node "/x/nexus-gate.mjs" pretool');
  });

  it.runIf(process.platform !== 'win32')('an inherited --require preload is not executed by the real hook command', () => {
    const home = prepareEphemeralHome(TOKEN, {});
    const command = gateEntries(home.dir, 'PreToolUse')[0]!.hooks![0]!.command!;
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gate-preload-'));
    try {
      const marker = path.join(sandbox, 'preload-ran');
      const preload = path.join(sandbox, 'admission-preload.cjs');
      fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n`);
      // Exactly how Claude Code 2.1.296 runs a shell-form hook: `sh -c`, with the pane env.
      const out = execFileSync('/bin/sh', ['-c', command], {
        input: JSON.stringify({ tool_name: 'mcp__nexus__nexus_handoff_submit', tool_input: {} }),
        encoding: 'utf8', timeout: 20_000,
        // Never reach a live Nexus (no gate URL, no ARMS descriptor fallback).
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, NEXUS_GATE_URL: '', NEXUS_GATE_TOKEN: '', NEXUS_HANDOFF_SPOOL_DIR: '',
          NEXUS_PANE_ARMS_DESCRIPTOR: path.join(sandbox, 'absent-arms-runtime.json') },
      });
      expect(out).toBe('');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
