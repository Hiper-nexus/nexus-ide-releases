import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { QuotaService } from './quota-service';
import { createRedlineSink } from './redline-sink';
import { resolveRedlineSnapshotPath } from './redline-sink';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';

const NOW = 1_800_000_000_000;

/**
 * Integração QuotaService → redline-sink → disco: o mesmo caminho que o
 * main.ts liga em produção (`persistSnapshot`), com o sink apontando para
 * um homedir temporário em vez de ~/.nexus.
 */
describe('QuotaService publica o snapshot do Redline', () => {
  const home = mkdtempSync(join(tmpdir(), 'redline-integration-'));
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('grava ~/.nexus/redline-last-good.json com ranking e sem label vazada', async () => {
    const sink = createRedlineSink({ homedir: home, now: () => NOW });
    const svc = new QuotaService({
      listProviders: () =>
        [
          { adapterId: 'claude', label: 'Claude', installed: true, enabled: true, authStrategy: 'subscription' },
        ] as ProviderSettingsInfo[],
      listAccounts: () =>
        [
          {
            id: 'a1',
            adapterId: 'claude',
            label: 'main',
            mode: 'subscription',
            upstream: 'anthropic',
            email: 'gustavo@gmail.com',
            createdAt: NOW,
            active: true,
            hasCredential: true,
            onCooldown: false,
            needsRelogin: false,
          } as AccountInfo,
        ],
      resolveClaudeAccessToken: () => 'fixture-token-not-to-be-persisted',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 42, resets_at: new Date(NOW + 3_600_000).toISOString() },
          seven_day: { utilization: 11, resets_at: new Date(NOW + 5 * 86_400_000).toISOString() },
        }),
        text: async () => '',
      }),
      persistSnapshot: (snap, accounts) => sink.persist(snap, accounts),
    });

    try {
      await svc.snapshot(NOW);
      // flush do sink é assíncrono
      await new Promise((r) => setTimeout(r, 30));
      const path = resolveRedlineSnapshotPath(home);
      expect(existsSync(path)).toBe(true);
      const file = JSON.parse(readFileSync(path, 'utf8'));
      expect(file.generatedBy).toBe('nexus');
      expect(file.formatVersion).toBe(1);
      expect(file.ranking.claude[0].entryId).toBe('claude:a1');
      expect(file.ranking.claude[0].emailMasked).toBe('gu****@g**.com');
      const json = readFileSync(path, 'utf8');
      // O token injetado NUNCA pode vazar para o arquivo do companheiro.
      expect(json).not.toContain('fixture-token-not-to-be-persisted');
      expect(json).not.toContain('gustavo@gmail.com');
    } finally {
      sink.stop();
      svc.stop();
    }
  });
});
