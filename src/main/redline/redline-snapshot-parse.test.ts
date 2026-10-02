import { describe, expect, it } from 'vitest';
import {
  REDLINE_MAX_ENTRIES,
  REDLINE_SNAPSHOT_MAX_BYTES,
  parseRedlineSnapshot,
  sanitizeDisplayText,
} from './redline-snapshot-parse';

const NOW = 1_780_000_000_000;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'claude:acc1',
    adapterId: 'claude',
    accountId: 'acc1',
    label: 'Claude Pessoal',
    emailMasked: 'gu****@g**.com',
    active: true,
    installed: true,
    onCooldown: false,
    windows: [
      { kind: 'session', label: 'Sessão', usedRatio: 0.9, resetsAt: NOW + 3_600_000 },
      { kind: 'weekly', label: 'Semanal', usedRatio: 0.4 },
    ],
    updatedAt: NOW,
    eligible: true,
    headroom: 0.1,
    decisiveWindow: { label: 'Sessão', effectiveUsedRatio: 0.9 },
    ...overrides,
  };
}

function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    formatVersion: 1,
    generatedBy: 'nexus',
    updatedAt: NOW,
    worstUsedRatio: 0.9,
    entries: [entry()],
    ranking: {
      claude: [
        {
          entryId: 'claude:acc1',
          adapterId: 'claude',
          label: 'Claude Pessoal',
          headroom: 0.1,
        },
      ],
    },
    statusBarEntryIds: ['claude:acc1'],
    ...overrides,
  });
}

describe('parseRedlineSnapshot', () => {
  it('parses a well-formed snapshot', () => {
    const snap = parseRedlineSnapshot(file());
    expect(snap).not.toBeNull();
    expect(snap?.formatVersion).toBe(1);
    expect(snap?.entries).toHaveLength(1);
    expect(snap?.entries[0].windows).toHaveLength(2);
    expect(snap?.entries[0].windows[0].usedRatio).toBe(0.9);
    expect(snap?.entries[0].windows[1].usedRatio).toBe(0.4);
    expect(snap?.statusBarEntryIds).toEqual(['claude:acc1']);
    expect(snap?.ranking.claude[0].headroom).toBe(0.1);
  });

  it.each([
    ['empty string', ''],
    ['not json', 'nope{'],
    ['truncated', file().slice(0, 40)],
    ['array root', '[]'],
    ['null root', 'null'],
    ['number root', '42'],
  ])('returns null for %s', (_name, text) => {
    expect(parseRedlineSnapshot(text)).toBeNull();
  });

  it('rejects an unknown formatVersion (fail closed)', () => {
    expect(parseRedlineSnapshot(file({ formatVersion: 2 }))).toBeNull();
    expect(parseRedlineSnapshot(file({ formatVersion: '1' }))).toBeNull();
    const noVersion = JSON.parse(file()) as Record<string, unknown>;
    delete noVersion.formatVersion;
    expect(parseRedlineSnapshot(JSON.stringify(noVersion))).toBeNull();
  });

  it('returns null when there is no usable entry', () => {
    expect(parseRedlineSnapshot(file({ entries: [] }))).toBeNull();
    expect(parseRedlineSnapshot(file({ entries: 'x' }))).toBeNull();
    expect(parseRedlineSnapshot(file({ entries: [{ label: 'sem id' }] }))).toBeNull();
    expect(parseRedlineSnapshot(file({ entries: [null, 1, 'a', []] }))).toBeNull();
  });

  it('drops invalid entries but keeps the valid ones', () => {
    const snap = parseRedlineSnapshot(
      file({
        entries: [
          entry({ id: '', label: 'sem id' }),
          entry({ id: 'codex:b', adapterId: 'codex', label: 'Codex' }),
          entry({ id: 'x', adapterId: '' }),
          'lixo',
        ],
      }),
    );
    expect(snap?.entries.map((e) => e.id)).toEqual(['codex:b']);
  });

  it('keeps unknown usage as null and never invents 0', () => {
    const snap = parseRedlineSnapshot(
      file({
        entries: [
          entry({
            windows: [
              { kind: 'weekly', label: 'Semanal' },
              { kind: 'session', label: 'Sessão', usedRatio: null },
              { kind: 'hours', label: '5 Horas', usedRatio: 'muito' },
              { kind: 'monthly', label: 'Mensal', usedRatio: Number.NaN },
              { kind: 'weekly', label: 'Semanal 2', usedRatio: -0.2 },
            ],
          }),
        ],
      }),
    );
    expect(snap?.entries[0].windows.map((w) => w.usedRatio)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('clamps a reading above 100% to 1 (exhausted is not unknown)', () => {
    const snap = parseRedlineSnapshot(
      file({ entries: [entry({ windows: [{ kind: 'weekly', label: 'S', usedRatio: 1.7 }] })] }),
    );
    expect(snap?.entries[0].windows[0].usedRatio).toBe(1);
  });

  it('maps unknown window kinds to local so they never drive the worst window', () => {
    const snap = parseRedlineSnapshot(
      file({ entries: [entry({ windows: [{ kind: 'quantum', label: 'Q', usedRatio: 0.99 }] })] }),
    );
    expect(snap?.entries[0].windows[0].kind).toBe('local');
  });

  it('keeps resetsAt only when it is a positive finite number', () => {
    const snap = parseRedlineSnapshot(
      file({
        entries: [
          entry({
            windows: [
              { kind: 'weekly', label: 'a', usedRatio: 0.1, resetsAt: 0 },
              { kind: 'weekly', label: 'b', usedRatio: 0.1, resetsAt: 'amanhã' },
              { kind: 'weekly', label: 'c', usedRatio: 0.1, resetsAt: NOW },
            ],
          }),
        ],
      }),
    );
    expect(snap?.entries[0].windows.map((w) => w.resetsAt)).toEqual([undefined, undefined, NOW]);
  });

  it('caps the number of entries and windows', () => {
    const many = Array.from({ length: REDLINE_MAX_ENTRIES + 25 }, (_, i) =>
      entry({ id: `claude:${i}`, label: `Conta ${i}` }),
    );
    const snap = parseRedlineSnapshot(file({ entries: many }));
    expect(snap?.entries).toHaveLength(REDLINE_MAX_ENTRIES);

    const wins = Array.from({ length: 40 }, (_, i) => ({
      kind: 'weekly',
      label: `w${i}`,
      usedRatio: 0.1,
    }));
    const snap2 = parseRedlineSnapshot(file({ entries: [entry({ windows: wins })] }));
    expect(snap2?.entries[0].windows.length).toBeLessThanOrEqual(12);
  });

  it('rejects a payload above the byte cap without parsing it', () => {
    const huge = file({ padding: 'x'.repeat(REDLINE_SNAPSHOT_MAX_BYTES) });
    expect(parseRedlineSnapshot(huge)).toBeNull();
  });

  it('counts the cap in bytes, not characters', () => {
    // 4 bytes por code point: o texto tem 1/4 dos caracteres mas estoura em bytes.
    const heavy = file({ padding: '𝕏'.repeat(Math.ceil(REDLINE_SNAPSHOT_MAX_BYTES / 4) + 10) });
    expect(parseRedlineSnapshot(heavy)).toBeNull();
  });

  it('survives prototype-pollution style keys without touching Object.prototype', () => {
    const text =
      '{"formatVersion":1,"entries":[{"id":"a","adapterId":"claude","windows":[]}],' +
      '"ranking":{"__proto__":[{"entryId":"a","adapterId":"claude","label":"x","headroom":1}]},' +
      '"__proto__":{"polluted":true},"statusBarEntryIds":["a"]}';
    const snap = parseRedlineSnapshot(text);
    expect(snap).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(snap?.ranking ?? {})).toBeNull();
  });

  it('never carries unexpected fields (tokens, secrets) from the file', () => {
    const snap = parseRedlineSnapshot(
      file({
        entries: [entry({ accessToken: 'sk-secret', apiKey: 'AKIA...', password: 'x' })],
        token: 'bearer abc',
      }),
    );
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('AKIA');
    expect(serialized).not.toContain('bearer abc');
  });

  it('filters statusBarEntryIds to strings and caps them', () => {
    const ids = [...Array.from({ length: 80 }, (_, i) => `id${i}`), 3, null, {}];
    const snap = parseRedlineSnapshot(file({ statusBarEntryIds: ids }));
    expect(snap?.statusBarEntryIds.every((id) => typeof id === 'string')).toBe(true);
    expect(snap?.statusBarEntryIds.length).toBeLessThanOrEqual(50);
  });

  it('missing statusBarEntryIds/ranking become empty (caller falls back)', () => {
    const base = JSON.parse(file()) as Record<string, unknown>;
    delete base.statusBarEntryIds;
    delete base.ranking;
    const snap = parseRedlineSnapshot(JSON.stringify(base));
    expect(snap?.statusBarEntryIds).toEqual([]);
    expect(snap?.ranking).toEqual({});
  });
});

describe('masked emails are never expanded (privacy guard)', () => {
  it('keeps an already masked email exactly as written', () => {
    const snap = parseRedlineSnapshot(file());
    expect(snap?.entries[0].emailMasked).toBe('gu****@g**.com');
  });

  it('re-masks a raw email that slipped into emailMasked', () => {
    const snap = parseRedlineSnapshot(
      file({ entries: [entry({ emailMasked: 'gustavo@gmail.com' })] }),
    );
    expect(snap?.entries[0].emailMasked).toBe('gu****@g**.com');
    expect(JSON.stringify(snap)).not.toContain('gustavo@gmail.com');
  });

  it('re-masks a raw email inside the label and ranking label', () => {
    const snap = parseRedlineSnapshot(
      file({
        entries: [entry({ label: 'Claude (gustavo@gmail.com)' })],
        ranking: {
          claude: [
            {
              entryId: 'claude:acc1',
              adapterId: 'claude',
              label: 'maria.silva@empresa.com.br',
              emailMasked: 'maria.silva@empresa.com.br',
              headroom: 0.5,
            },
          ],
        },
      }),
    );
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('gustavo@gmail.com');
    expect(serialized).not.toContain('maria.silva@empresa.com.br');
    expect(snap?.entries[0].label).toContain('gu****@g**.com');
  });
});

describe('sanitizeDisplayText', () => {
  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeDisplayText('a\u0000b\u0007c\n\t d   e', 50)).toBe('abc d e');
  });

  it('strips bidi overrides and zero-width characters', () => {
    expect(sanitizeDisplayText('ab‮cd​ef⁦gh⁩', 50)).toBe('abcdefgh');
  });

  it('caps by code point without splitting a surrogate pair', () => {
    const out = sanitizeDisplayText('A😀B😀C', 3);
    expect(out).toBe('A😀…');
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it('returns an empty string for non-strings', () => {
    expect(sanitizeDisplayText(undefined, 10)).toBe('');
    expect(sanitizeDisplayText(42, 10)).toBe('');
  });
});
