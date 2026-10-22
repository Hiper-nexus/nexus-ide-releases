// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The effectful kit tools, handler by handler. The read-only pair has its own
 * file (`tools-ui-kit-read-only.test.ts`); this one covers the answers the
 * review found wrong on the doors that DO run something.
 */
vi.mock('node:child_process', () => {
  const explode = () => {
    throw new Error('these handlers must not spawn in this test');
  };
  return { spawn: explode, spawnSync: explode, exec: explode, execFile: explode };
});

const project = vi.hoisted(() => ({ root: '' }));
vi.mock('./gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gate')>()),
  executionScopeFor: () => ({ rootRealPath: project.root }),
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ uiKitRegistries: [] }),
}));

const service = vi.hoisted(() => ({
  runShadcnCommand: vi.fn(),
  activateEffectiveBoardUiLicense: vi.fn(),
  boardUiLicenseStatus: vi.fn(),
  provisionBundledBoardUiLicense: vi.fn(),
}));
vi.mock('../ui-kit/ui-kit-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui-kit/ui-kit-service')>()),
  runShadcnCommand: service.runShadcnCommand,
  activateEffectiveBoardUiLicense: service.activateEffectiveBoardUiLicense,
  boardUiLicenseStatus: service.boardUiLicenseStatus,
  provisionBundledBoardUiLicense: service.provisionBundledBoardUiLicense,
}));

const { buildUiKitTools } = await import('./tools-ui-kit');

const ctx = {} as Parameters<ReturnType<typeof buildUiKitTools>[0]['handler']>[1];

function tool(name: string) {
  const found = buildUiKitTools().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool not built: ${name}`);
  return found;
}

beforeEach(() => {
  project.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-tools-'));
  service.runShadcnCommand.mockReset();
  service.runShadcnCommand.mockResolvedValue({
    ok: true, stdout: '', stderr: '', code: 0, missingRegistryKeys: [],
  });
  service.activateEffectiveBoardUiLicense.mockReset();
  service.boardUiLicenseStatus.mockReset();
  service.provisionBundledBoardUiLicense.mockReset();
});

afterEach(() => {
  fs.rmSync(project.root, { recursive: true, force: true });
});

describe('nexus_ui_kit_add in a project with no components.json', () => {
  it('answers at once with the way out, before any search or install', async () => {
    const started = Date.now();
    const out = (await tool('nexus_ui_kit_add').handler(
      { kit: 'shadcn', items: ['button'] },
      ctx,
    )) as { ok: boolean; refusal: string; hint: string; installed: string[] };

    expect(out.ok).toBe(false);
    expect(out.refusal).toBe('components_json_missing');
    expect(out.hint).toMatch(/command: 'init'/);
    expect(out.installed).toEqual([]);
    expect(service.runShadcnCommand).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses a task pick too, naming both ways forward', async () => {
    const out = (await tool('nexus_ui_kit_add').handler(
      { task: 'uma tela de login' },
      ctx,
    )) as { refusal: string; hint: string };

    expect(out.refusal).toBe('components_json_missing');
    expect(out.hint).toMatch(/kit: 'boardui'/);
    expect(service.runShadcnCommand).not.toHaveBeenCalled();
  });
});

describe('nexus_ui_kit_run init', () => {
  it('runs non-interactively with the vendor defaults when no preset is given', async () => {
    await tool('nexus_ui_kit_run').handler({ command: 'init' }, ctx);

    expect(service.runShadcnCommand.mock.calls[0]?.[0].command).toMatchObject({
      kind: 'init',
      defaults: true,
    });
  });

  it('leaves the defaults off when the caller chose a preset', async () => {
    await tool('nexus_ui_kit_run').handler({ command: 'init', preset: 'abc123' }, ctx);

    expect(service.runShadcnCommand.mock.calls[0]?.[0].command).not.toHaveProperty('defaults');
  });

  it('stops before spawning when the call was superseded', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool('nexus_ui_kit_run').handler({ command: 'info' }, ctx, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(service.runShadcnCommand).not.toHaveBeenCalled();
  });
});

describe('nexus_ui_kit_boardui licence tools on the bundled key', () => {
  it('activate_license provisions the bundled licence instead of refusing "no key stored"', async () => {
    service.activateEffectiveBoardUiLicense.mockResolvedValue({
      ok: true, stored: false, provisioned: true, detail: 'operator licence provisioned on this machine',
    });

    const out = (await tool('nexus_ui_kit_boardui').handler(
      { tool: 'activate_license' },
      ctx,
    )) as { ok: boolean; provisioned?: boolean };

    expect(out).toMatchObject({ ok: true, provisioned: true });
    expect(service.activateEffectiveBoardUiLicense).toHaveBeenCalledTimes(1);
  });

  it('license_status puts the bundled licence in place before asking', async () => {
    service.boardUiLicenseStatus.mockResolvedValue({
      state: 'active', masked: null, stored: false, operatorKey: true,
    });

    await tool('nexus_ui_kit_boardui').handler({ tool: 'license_status' }, ctx);

    expect(service.provisionBundledBoardUiLicense).toHaveBeenCalledTimes(1);
    expect(service.provisionBundledBoardUiLicense.mock.invocationCallOrder[0]).toBeLessThan(
      service.boardUiLicenseStatus.mock.invocationCallOrder[0] as number,
    );
  });
});

describe('a project the kits cannot serve', () => {
  it('refuses a Vue project at once, naming the framework', async () => {
    fs.writeFileSync(
      path.join(project.root, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
    );

    const out = (await tool('nexus_ui_kit_add').handler({ task: 'uma tela de login' }, ctx)) as {
      ok: boolean;
      refusal: string;
      hint: string;
    };

    expect(out).toMatchObject({ ok: false, refusal: 'framework_unsupported' });
    expect(out.hint).toContain('Vue');
    expect(service.runShadcnCommand).not.toHaveBeenCalled();
  });

  it('refuses shadcn init in an Expo project', async () => {
    fs.writeFileSync(
      path.join(project.root, 'package.json'),
      JSON.stringify({ dependencies: { react: '19.0.0', expo: '^54.0.0' } }),
    );

    const out = (await tool('nexus_ui_kit_run').handler({ command: 'init' }, ctx)) as {
      ok: boolean;
      refusal: string;
    };

    expect(out).toMatchObject({ ok: false, refusal: 'framework_unsupported' });
    expect(service.runShadcnCommand).not.toHaveBeenCalled();
  });
});
