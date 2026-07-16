/**
 * Caminho de escrita do painel Labs: applyFlagOverride valida, aplica no
 * registry vivo, persiste em disco e devolve a lista re-resolvida.
 * Ids desconhecidos e payloads malformados falham fechado.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';

// Hermético: o módulo importa 'electron' (ipcMain/BrowserWindow), que exige o
// binário instalado; applyFlagOverride não toca em nenhum dos dois.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
import {
  configureFeatureFlagRegistry,
  getFeatureFlagRegistry,
  resetFeatureFlagRegistryForTests,
} from './feature-flags/feature-flag-registry';

const tempDirs: string[] = [];

afterEach(() => {
  resetFeatureFlagRegistryForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function configureTempRegistry(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-labs-'));
  tempDirs.push(dir);
  const overridesPath = path.join(dir, 'feature-flags.json');
  configureFeatureFlagRegistry({ runtimeChannel: 'stable', overridesPath });
  return overridesPath;
}

describe('applyFlagOverride (Labs)', () => {
  it('sets a persisted override and returns the re-resolved list', async () => {
    const overridesPath = configureTempRegistry();
    const { applyFlagOverride } = await import('./product-wave-ipc');

    // Override OFF sobre default-ON — distinto do default, persiste em disco.
    const list = applyFlagOverride({
      id: FEATURE_FLAG_IDS.mcpHub,
      enabled: false,
    });
    const hub = list.find((row) => row.id === FEATURE_FLAG_IDS.mcpHub);
    expect(hub).toMatchObject({ enabled: false, reason: 'override' });

    const onDisk = JSON.parse(fs.readFileSync(overridesPath, 'utf8')) as {
      overrides: Array<{ id: string; enabled: boolean }>;
    };
    expect(onDisk.overrides).toContainEqual({
      id: FEATURE_FLAG_IDS.mcpHub,
      enabled: false,
    });
  });

  it('enabled: null clears the override back to the builtin default', async () => {
    configureTempRegistry();
    const { applyFlagOverride } = await import('./product-wave-ipc');

    applyFlagOverride({ id: FEATURE_FLAG_IDS.searchMixer, enabled: false });
    expect(
      getFeatureFlagRegistry().resolve(FEATURE_FLAG_IDS.searchMixer).reason,
    ).toBe('override');

    const list = applyFlagOverride({
      id: FEATURE_FLAG_IDS.searchMixer,
      enabled: null,
    });
    const mixer = list.find((row) => row.id === FEATURE_FLAG_IDS.searchMixer);
    expect(mixer).toMatchObject({ enabled: true, reason: 'default' });
  });

  it('fails closed on unknown ids and malformed payloads', async () => {
    configureTempRegistry();
    const { applyFlagOverride } = await import('./product-wave-ipc');

    expect(() =>
      applyFlagOverride({ id: 'feature.does.not.exist', enabled: true }),
    ).toThrow(/unknown feature flag/);
    expect(() => applyFlagOverride({ id: '', enabled: true })).toThrow();
    expect(() =>
      applyFlagOverride({ id: FEATURE_FLAG_IDS.mcpHub, enabled: 'yes' }),
    ).toThrow();
    expect(() =>
      applyFlagOverride({
        id: FEATURE_FLAG_IDS.mcpHub,
        enabled: true,
        extra: 1,
      }),
    ).toThrow();
  });
});
