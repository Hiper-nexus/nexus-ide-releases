import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountInfo } from '../../shared/account-types';
import type { ProviderQuotaEntry, QuotaFleetSnapshot } from '../../shared/quota-types';
import {
  REDLINE_SNAPSHOT_FORMAT_VERSION,
  maskEmail,
} from '../../shared/redline-types';
import {
  buildRedlineSnapshotFile,
  createRedlineSink,
  resolveRedlineSnapshotPath,
  writeRedlineSnapshotFileSync,
} from './redline-sink';

const NOW = 1_800_000_000_000;

function account(id: string, email?: string): AccountInfo {
  return {
    id,
    adapterId: 'claude',
    label: id,
    mode: 'subscription',
    upstream: 'anthropic',
    ...(email ? { email } : {}),
    createdAt: NOW,
    active: true,
    hasCredential: true,
    onCooldown: false,
    needsRelogin: false,
  } as AccountInfo;
}

function snapshotWith(entries: ProviderQuotaEntry[]): QuotaFleetSnapshot {
  return {
    updatedAt: NOW,
    entries,
    worstUsedRatio: 0.5,
    highUsageCount: 0,
    unknownCount: 0,
  };
}

describe('maskEmail', () => {
  it('mascara no formato do Redline', () => {
    expect(maskEmail('gustavo@gmail.com')).toBe('gu****@g**.com');
    expect(maskEmail(undefined)).toBeUndefined();
    expect(maskEmail('sem-arroba')).toBe('***');
  });
});

describe('buildRedlineSnapshotFile', () => {
  it.each(['quota-key-required', 'unavailable', 'cli-missing', 'auth-expired'] as const)(
    'preserves the actionable quota diagnosis %s for the companion', (readHint) => {
      const file = buildRedlineSnapshotFile(snapshotWith([{
        id: 'minimax-code', adapterId: 'minimax-code', label: 'MiniMax',
        installed: true, onCooldown: false, windows: [], readHint, updatedAt: NOW,
      }]), [], NOW);
      expect(file.entries[0]).toMatchObject({ readHint });
    },
  );
  it('F-720: GLM e GLM Flash na mesma chave viram uma linha só no Redline', () => {
    const zai = (id: string, label: string): ProviderQuotaEntry => ({
      id,
      adapterId: id,
      label,
      installed: true,
      onCooldown: false,
      quotaGroup: 'zai-key',
      windows: [
        { kind: 'hours', label: '5h', usedRatio: 0.038, resetsAt: NOW + 3_600_000, source: 'provider-api', confidence: 'high' },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.661, resetsAt: NOW + 70_000_000, source: 'provider-api', confidence: 'high' },
      ],
      updatedAt: NOW,
    });
    const file = buildRedlineSnapshotFile(
      snapshotWith([zai('glm', 'GLM (z.ai)'), zai('glm-flash', 'GLM Flash (z.ai)')]),
      [],
      NOW,
    );
    expect(file.entries.map((entry) => entry.label)).toEqual(['GLM (z.ai)']);
    expect(file.statusBarEntryIds).toEqual(['glm']);
  });

  it('shape do arquivo: versão, gerador, ranking e sem segredos', () => {
    const file = buildRedlineSnapshotFile(
      snapshotWith([
        {
          id: 'claude:a',
          adapterId: 'claude',
          accountId: 'a',
          label: 'Claude · a',
          installed: true,
          onCooldown: false,
          active: true,
          windows: [
            {
              kind: 'hours',
              label: '5h',
              usedRatio: 0.3,
              resetsAt: NOW + 3_600_000,
              source: 'provider-api',
              confidence: 'high',
            },
          ],
          updatedAt: NOW,
        },
      ]),
      [account('a', 'gustavo@gmail.com')],
      NOW,
    );
    expect(file.formatVersion).toBe(REDLINE_SNAPSHOT_FORMAT_VERSION);
    expect(file.generatedBy).toBe('nexus');
    expect(file.ranking.claude).toHaveLength(1);
    expect(file.ranking.claude[0].emailMasked).toBe('gu****@g**.com');
    const json = JSON.stringify(file);
    expect(json).not.toContain('gustavo@gmail.com');
    expect(json.toLowerCase()).not.toContain('token');
  });

  it('rótulo da frota com e-mail não aparece inteiro no JSON', () => {
    const file = buildRedlineSnapshotFile(
      snapshotWith([
        {
          id: 'claude:a',
          adapterId: 'claude',
          accountId: 'a',
          label: 'Claude · gustavo@gmail.com',
          installed: true,
          onCooldown: false,
          active: true,
          windows: [
            {
              kind: 'hours',
              label: '5h',
              usedRatio: 0.3,
              source: 'provider-api',
              confidence: 'high',
            },
          ],
          updatedAt: NOW,
        },
      ]),
      [account('a', 'gustavo@gmail.com')],
      NOW,
    );
    const json = JSON.stringify(file);
    expect(json).not.toContain('gustavo@gmail.com');
    expect(file.entries[0]?.label).toBe('Claude · g•••@g•••.com');
    expect(file.ranking.claude[0]?.label).toBe('Claude · g•••@g•••.com');
  });

  it('statusBarEntryIds só inclui contas com usedRatio (F-612)', () => {
    const file = buildRedlineSnapshotFile(
      snapshotWith([
        {
          id: 'glm',
          adapterId: 'glm',
          label: 'GLM',
          installed: true,
          onCooldown: false,
          active: true,
          windows: [
            {
              kind: 'weekly',
              label: 'Semanal',
              usedRatio: 0.13,
              source: 'provider-api',
              confidence: 'high',
            },
          ],
          updatedAt: NOW,
        },
        {
          id: 'claude:a',
          adapterId: 'claude',
          accountId: 'a',
          label: 'Claude',
          installed: true,
          onCooldown: false,
          active: true,
          windows: [
            {
              kind: 'hours',
              label: '5 Horas',
              usedRatio: null,
              source: 'unknown',
              confidence: 'low',
            },
          ],
          updatedAt: NOW,
        },
      ]),
      [account('a')],
      NOW,
    );
    expect(file.statusBarEntryIds).toEqual(['glm']);
    expect(file.entries.map((entry) => entry.id)).toEqual(['glm', 'claude:a']);
  });

  it('statusBarEntryIds escolhe as contas mais gastas, não as primeiras no alfabeto', () => {
    const window = (usedRatio: number | null) => ({
      kind: 'hours' as const,
      label: '5 Horas',
      usedRatio,
      source: usedRatio == null ? ('unknown' as const) : ('provider-api' as const),
      confidence: usedRatio == null ? ('low' as const) : ('high' as const),
    });
    const row = (
      id: string,
      adapterId: string,
      label: string,
      usedRatio: number | null,
    ): ProviderQuotaEntry => ({
      id,
      adapterId,
      label,
      installed: true,
      onCooldown: false,
      active: true,
      windows: [window(usedRatio)],
      updatedAt: NOW,
    });
    const file = buildRedlineSnapshotFile(
      snapshotWith([
        row('alpha', 'agy', 'Agy · baixa', 0.05),
        row('unknown', 'kimi', 'Kimi · sem leitura', null),
        row('zulu', 'glm', 'Z.ai · alta', 0.91),
        row('mid', 'codex', 'Codex · meio', 0.4),
      ]),
      [account('a')],
      NOW,
    );
    expect(file.statusBarEntryIds).toEqual(['zulu', 'mid', 'alpha']);
    expect(file.entries.map((entry) => entry.id)).toEqual([
      'zulu',
      'mid',
      'alpha',
      'unknown',
    ]);
  });
});

describe('writeRedlineSnapshotFileSync + sink', () => {
  const home = mkdtempSync(join(tmpdir(), 'redline-sink-'));
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('grava atômico, 0600, e substitui o anterior', () => {
    const path = resolveRedlineSnapshotPath(home);
    const file = buildRedlineSnapshotFile(snapshotWith([]), [], NOW);
    writeRedlineSnapshotFileSync(path, file);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.formatVersion).toBe(REDLINE_SNAPSHOT_FORMAT_VERSION);
    writeRedlineSnapshotFileSync(path, {
      ...file,
      worstUsedRatio: 0.9,
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).worstUsedRatio).toBe(0.9);
  });

  it('persist coalesce e deixa o arquivo em disco', async () => {
    const sink = createRedlineSink({ homedir: home, now: () => NOW });
    try {
      sink.persist(snapshotWith([]), []);
      // primeiro flush é agendado; espera o microtask drenar
      await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(resolveRedlineSnapshotPath(home))).toBe(true);
    } finally {
      sink.stop();
    }
  });

  it('watchRefreshRequests dispara uma vez e consome o arquivo-sinal', async () => {
    const sink = createRedlineSink({ homedir: home, now: () => NOW });
    const calls: number[] = [];
    const stop = sink.watchRefreshRequests(() => calls.push(Date.now()));
    try {
      mkdirSync(join(home, '.nexus'), { recursive: true });
      writeFileSync(join(home, '.nexus', 'redline-refresh.request'), '{}');
      await new Promise((r) => setTimeout(r, 1_600));
      expect(calls.length).toBe(1);
      expect(
        existsSync(join(home, '.nexus', 'redline-refresh.request')),
      ).toBe(false);
    } finally {
      stop();
      sink.stop();
    }
  });

  it('path unwritable não lança — warn silencioso', async () => {
    const locked = join(home, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500); // read-only
    const sink = createRedlineSink({ homedir: locked, now: () => NOW });
    try {
      sink.persist(snapshotWith([]), []);
      await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(resolveRedlineSnapshotPath(locked))).toBe(false);
    } finally {
      sink.stop();
      chmodSync(locked, 0o700);
    }
  });
});

describe('Redline com estimativa (revisão F-1416/F-1417)', () => {
  it('número estimado aparece marcado e não vira o pior consumo nem a barra', () => {
    const file = buildRedlineSnapshotFile(snapshotWith([
      {
        id: 'qwen', adapterId: 'qwen', label: 'Qwen', installed: true, onCooldown: false,
        windows: [{ kind: 'monthly', label: 'Mensal', usedRatio: 0.9, source: 'provider-api', confidence: 'low' }],
        updatedAt: NOW,
      },
    ]), [], NOW);
    expect(file.entries[0]!.windows[0]).toMatchObject({ usedRatio: 0.9, estimated: true });
    expect(file.worstUsedRatio).toBeNull();
    expect(file.statusBarEntryIds).toEqual([]);
  });
});
