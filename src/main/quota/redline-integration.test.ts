import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { QuotaService } from './quota-service';
import { buildRedlineSnapshotFile, createRedlineSink } from './redline-sink';
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
      resolveClaudeAccessToken: () => { throw new Error('pinned token resolver must not run'); },
      claudeAccountUsage: async () => ({ windows: [
        { kind: 'hours', label: '5 Horas', usedRatio: 0.42, source: 'provider-api', confidence: 'high',
          resetsAt: NOW + 3_600_000 },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.11, source: 'provider-api', confidence: 'high',
          resetsAt: NOW + 5 * 86_400_000 },
      ] }),
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

  it('never sends a mismatched Claude percentage to the Redline bar', () => {
    const snap = { updatedAt: NOW, worstUsedRatio: 0.86, highUsageCount: 1,
      unknownCount: 0, entries: [{
        id: 'claude:a1', adapterId: 'claude', accountId: 'a1', label: 'Claude · A',
        installed: true, onCooldown: true, readHint: 'identity-mismatch' as const,
        windows: [{ kind: 'weekly' as const, label: 'Semanal', usedRatio: 0.86,
          source: 'provider-api' as const, confidence: 'high' as const }], updatedAt: NOW,
      }] };
    const file = buildRedlineSnapshotFile(snap, [], NOW);
    expect(file.entries[0]?.windows[0]?.usedRatio).toBeNull();
    expect(file.statusBarEntryIds).toEqual([]);
    expect(file.worstUsedRatio).toBeNull();
  });
});
