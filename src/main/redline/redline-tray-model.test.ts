import { describe, expect, it } from 'vitest';
import type {
  RedlineEntry,
  RedlineSnapshotFile,
  RedlineWindow,
} from '../../shared/redline-types';
import { parseRedlineSnapshot } from './redline-snapshot-parse';
import {
  accountState,
  ageLabel,
  barsText,
  bestRankingPick,
  buildRedlineTrayModel,
  compactWindowLabel,
  durationText,
  entriesForBar,
  isStale,
  pctText,
  providerName,
  resetText,
  urgencyFor,
  urgencyWord,
  worstBarWindow,
  type RedlineMenuItem,
} from './redline-tray-model';

const NOW = 1_780_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function win(overrides: Partial<RedlineWindow> = {}): RedlineWindow {
  return { kind: 'weekly', label: 'Semanal', usedRatio: 0.4, ...overrides };
}

function entry(overrides: Partial<RedlineEntry> = {}): RedlineEntry {
  return {
    id: 'claude:a',
    adapterId: 'claude',
    label: 'Claude Pessoal',
    active: false,
    installed: true,
    onCooldown: false,
    windows: [win()],
    updatedAt: NOW,
    eligible: true,
    ...overrides,
  };
}

function snapshot(
  entries: RedlineEntry[],
  overrides: Partial<RedlineSnapshotFile> = {},
): RedlineSnapshotFile {
  return {
    formatVersion: 1,
    generatedBy: 'nexus',
    updatedAt: NOW,
    worstUsedRatio: null,
    entries,
    ranking: {},
    statusBarEntryIds: entries.map((e) => e.id),
    ...overrides,
  };
}

function texts(items: readonly RedlineMenuItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === 'separator') return ['---'];
    if (item.kind === 'submenu') return [`>${item.text}`, ...texts(item.items).map((t) => `  ${t}`)];
    return [item.text];
  });
}

function flat(items: readonly RedlineMenuItem[]): string {
  return texts(items).join('\n');
}

describe('formatting parity with the Mac/Windows companions', () => {
  it.each([
    [0, '0%'],
    [0.004, '0%'],
    [0.005, '1%'],
    [0.62, '62%'],
    [0.9, '90%'],
    [1, '100%'],
  ])('pctText(%s) = %s', (used, expected) => {
    expect(pctText(used)).toBe(expected);
  });

  it('pctText shows an em dash for unknown, never 0%', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText(null)).not.toContain('0');
  });

  it.each([
    [0, '▯▯▯▯▯'],
    [0.09, '▯▯▯▯▯'],
    [0.1, '▮▯▯▯▯'],
    [0.3, '▮▮▯▯▯'],
    [0.62, '▮▮▮▯▯'],
    [0.9, '▮▮▮▮▮'],
    [1, '▮▮▮▮▮'],
  ])('barsText(%s) = %s (5 blocks, half rounds up)', (used, expected) => {
    expect(barsText(used)).toBe(expected);
  });

  it('barsText for unknown is the neutral dotted bar', () => {
    expect(barsText(null)).toBe('·····');
  });

  it('urgency thresholds are 60% and 85%', () => {
    expect(urgencyFor(null)).toBe('unknown');
    expect(urgencyFor(0)).toBe('ok');
    expect(urgencyFor(0.5999)).toBe('ok');
    expect(urgencyFor(0.6)).toBe('warn');
    expect(urgencyFor(0.8499)).toBe('warn');
    expect(urgencyFor(0.85)).toBe('danger');
    expect(urgencyFor(1)).toBe('danger');
  });

  it('urgency has a word, never only a color', () => {
    expect(urgencyWord('danger')).toBe('crítico');
    expect(urgencyWord('warn')).toBe('atenção');
    expect(urgencyWord('ok')).toBe('ok');
    expect(urgencyWord('unknown')).toBe('sem leitura');
  });

  it.each([
    [NOW - 5_000, 'agora mesmo'],
    [NOW + 60_000, 'agora mesmo'],
    [NOW - 89_000, 'agora mesmo'],
    [NOW - 3 * MIN, 'há 3 min'],
    [NOW - 59 * MIN, 'há 59 min'],
    [NOW - 2 * HOUR, 'há 2h'],
    [NOW - 35 * HOUR, 'há 35h'],
    [NOW - 4 * 24 * HOUR, 'há 4d'],
  ])('ageLabel(%s)', (updatedAt, expected) => {
    expect(ageLabel(updatedAt, NOW)).toBe(expected);
  });

  it('isStale flips after 10 minutes', () => {
    expect(isStale(NOW - 10 * MIN, NOW)).toBe(false);
    expect(isStale(NOW - 10 * MIN - 1_000, NOW)).toBe(true);
    expect(isStale(0, NOW)).toBe(true);
  });

  it('a snapshot dated far in the future is treated as stale (clock skew or forged)', () => {
    expect(isStale(NOW + 30 * MIN, NOW)).toBe(true);
    expect(isStale(NOW + 2 * MIN, NOW)).toBe(false);
    expect(buildRedlineTrayModel(snapshot([entry()], { updatedAt: NOW + 3 * HOUR }), NOW).stale).toBe(true);
  });

  it('providerName is safe for names that exist on Object.prototype', () => {
    expect(providerName('constructor')).toBe('Constructor');
    expect(providerName('toString')).toBe('ToString');
    expect(providerName('__proto__')).toBe('__proto__');
    expect(() =>
      buildRedlineTrayModel(snapshot([entry({ adapterId: 'constructor', label: '' })]), NOW),
    ).not.toThrow();
  });

  it('providerName follows the companions', () => {
    expect(providerName('claude')).toBe('Claude');
    expect(providerName('agy')).toBe('Antigravity');
    expect(providerName('minimax-code')).toBe('MiniMax Code');
    expect(providerName('kimi')).toBe('Kimi');
    expect(providerName('')).toBe('');
  });
});

describe('reset countdown wording', () => {
  it.each([
    [NOW + 30_000, 'reset em 1m'],
    [NOW + 38 * MIN, 'reset em 38m'],
    [NOW + 59 * MIN + 30_000, 'reset em 1h'],
    [NOW + HOUR, 'reset em 1h'],
    [NOW + HOUR + 20 * MIN, 'reset em 1h20'],
    [NOW + HOUR + 5 * MIN, 'reset em 1h05'],
    [NOW + 12 * HOUR, 'reset em 12h'],
    [NOW + 47 * HOUR + 59 * MIN, 'reset em 47h59'],
    [NOW + 48 * HOUR, 'reset em 2d'],
    [NOW + 5 * 24 * HOUR + HOUR, 'reset em 6d'],
  ])('resetText(%s) = %s', (resetsAt, expected) => {
    expect(resetText(resetsAt, NOW)).toBe(expected);
  });

  it('an expired reset says "reset agora", never a negative duration', () => {
    expect(resetText(NOW, NOW)).toBe('reset agora');
    expect(resetText(NOW - 5 * HOUR, NOW)).toBe('reset agora');
    expect(durationText(NOW - 1, NOW)).toBe('agora');
  });

  it('an absurd reset time is bounded instead of printing 1e+296d', () => {
    expect(resetText(NOW + 400 * 24 * HOUR, NOW)).toBe('reset em 99d+');
    expect(resetText(Number.MAX_VALUE, NOW)).toBe('reset em 99d+');
    expect(resetText(NOW + 99 * 24 * HOUR, NOW)).toBe('reset em 99d');
  });

  it('an unknown reset time prints nothing', () => {
    expect(resetText(undefined, NOW)).toBe('');
    expect(durationText(undefined, NOW)).toBeNull();
    expect(durationText(Number.NaN, NOW)).toBeNull();
  });
});

describe('compactWindowLabel', () => {
  const label = (kind: RedlineWindow['kind'], text: string) => compactWindowLabel({ kind, label: text });

  it('abbreviates the simple labels', () => {
    expect(label('hours', '5 Horas')).toBe('5h');
    expect(label('hours', '5h')).toBe('5h');
    expect(label('hours', '3 hours')).toBe('3h');
    expect(label('weekly', 'Semanal')).toBe('semana');
    expect(label('weekly', 'Weekly')).toBe('semana');
    expect(label('session', 'Sessão')).toBe('sessão');
    expect(label('monthly', 'Mensal')).toBe('mês');
  });

  it('keeps a specific label so two weekly windows never collide', () => {
    expect(label('weekly', 'Opus semanal')).toBe('Opus semanal');
    expect(label('weekly', 'Sonnet semanal')).toBe('Sonnet semanal');
  });

  it('falls back to the kind when the label is empty and clips a huge one', () => {
    expect(label('credits', '')).toBe('créditos');
    expect(label('local', '  ')).toBe('local');
    expect(Array.from(label('weekly', 'x'.repeat(200))).length).toBeLessThanOrEqual(24);
  });
});

describe('entriesForBar / worstBarWindow / bestRankingPick', () => {
  it('uses statusBarEntryIds in snapshot order, not the id order', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    const c = entry({ id: 'c' });
    const snap = snapshot([a, b, c], { statusBarEntryIds: ['c', 'a'] });
    expect(entriesForBar(snap).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('falls back to the first 6 entries with a reading when ids are missing', () => {
    const entries = [
      entry({ id: 'unk', windows: [win({ usedRatio: null })] }),
      ...Array.from({ length: 8 }, (_, i) => entry({ id: `k${i}` })),
    ];
    const snap = snapshot(entries, { statusBarEntryIds: [] });
    expect(entriesForBar(snap).map((e) => e.id)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  });

  it('never lists more than 6 accounts even if the file names more ids', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ id: `k${i}`, label: `Conta ${i}` }));
    const snap = snapshot(entries, { statusBarEntryIds: entries.map((e) => e.id) });
    expect(entriesForBar(snap)).toHaveLength(6);
    expect(entriesForBar(snap).map((e) => e.id)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  });

  it('also falls back when none of the ids matches an entry (stale ids)', () => {
    const snap = snapshot([entry({ id: 'a' })], { statusBarEntryIds: ['gone'] });
    expect(entriesForBar(snap).map((e) => e.id)).toEqual(['a']);
  });

  it('worst window ignores credits/local kinds and unknown readings', () => {
    const e = entry({
      windows: [
        win({ kind: 'credits', usedRatio: 0.99 }),
        win({ kind: 'local', usedRatio: 0.98 }),
        win({ kind: 'weekly', usedRatio: null }),
        win({ kind: 'session', label: 'Sessão', usedRatio: 0.7 }),
      ],
    });
    const worst = worstBarWindow([e]);
    expect(worst?.window.kind).toBe('session');
    expect(worst?.usedRatio).toBe(0.7);
  });

  it('worst window is null when nothing has an honest reading', () => {
    expect(worstBarWindow([entry({ windows: [win({ usedRatio: null })] })])).toBeNull();
    expect(worstBarWindow([])).toBeNull();
  });

  it('the first account wins a tie on the worst window', () => {
    const a = entry({ id: 'a', windows: [win({ usedRatio: 0.5 })] });
    const b = entry({ id: 'b', windows: [win({ usedRatio: 0.5 })] });
    expect(worstBarWindow([a, b])?.entry.id).toBe('a');
  });

  it('bestRankingPick returns the highest headroom across adapters', () => {
    const snap = snapshot([entry()], {
      ranking: {
        claude: [{ entryId: 'claude:a', adapterId: 'claude', label: 'x', headroom: 0.2 }],
        codex: [
          { entryId: 'codex:b', adapterId: 'codex', label: 'y', headroom: 0.7 },
          { entryId: 'codex:c', adapterId: 'codex', label: 'z', headroom: 0.4 },
        ],
      },
    });
    expect(bestRankingPick(snap)?.entryId).toBe('codex:b');
    expect(bestRankingPick(snapshot([entry()]))).toBeNull();
  });
});

describe('accountState', () => {
  it('is empty for a healthy account', () => {
    expect(accountState(entry(), NOW)).toBe('');
  });

  it('says cooldown with the remaining time', () => {
    expect(
      accountState(entry({ onCooldown: true, cooldownUntil: NOW + 12 * MIN }), NOW),
    ).toBe('Em espera · 12m');
  });

  it('says cooldown without a time when the end is unknown', () => {
    expect(accountState(entry({ onCooldown: true }), NOW)).toBe('Em espera');
    expect(accountState(entry({ excludedReason: 'cooldown' }), NOW)).toBe('Em espera');
  });

  it('names credential and session problems in words', () => {
    expect(accountState(entry({ excludedReason: 'no-credential' }), NOW)).toBe('Sem credencial');
    expect(accountState(entry({ excludedReason: 'needs-relogin' }), NOW)).toBe('Sessão expirada');
    expect(accountState(entry({ excludedReason: 'unknown-usage' }), NOW)).toBe('');
  });

  it('does not double-report cooldown', () => {
    expect(
      accountState(
        entry({ onCooldown: true, cooldownUntil: NOW + MIN, excludedReason: 'cooldown' }),
        NOW,
      ),
    ).toBe('Em espera · 1m');
  });
});

describe('buildRedlineTrayModel — empty and degraded snapshots', () => {
  it('no snapshot: waiting message, only the three actions, unknown urgency', () => {
    const model = buildRedlineTrayModel(null, NOW);
    expect(model.hasData).toBe(false);
    expect(model.urgency).toBe('unknown');
    expect(model.stale).toBe(true);
    expect(model.tooltip).toContain('aguardando');
    const actions = model.items.filter((i) => i.kind === 'action');
    expect(actions.map((a) => (a.kind === 'action' ? a.action : ''))).toEqual([
      'refresh',
      'open-quota',
      'hide',
    ]);
    expect(flat(model.items)).toContain('sem dados de cota ainda');
  });

  it('a snapshot with zero entries is treated as no data', () => {
    expect(buildRedlineTrayModel(snapshot([]), NOW).hasData).toBe(false);
  });

  it('every window unknown: no 0%, header says no reading, urgency unknown', () => {
    const snap = snapshot(
      [
        entry({
          id: 'a',
          windows: [win({ kind: 'hours', label: '5 Horas', usedRatio: null }), win({ usedRatio: null })],
        }),
      ],
      { statusBarEntryIds: [] },
    );
    const model = buildRedlineTrayModel(snap, NOW);
    const text = flat(model.items);
    expect(model.urgency).toBe('unknown');
    expect(text).toContain('sem leitura de cota nas contas');
    expect(text).toContain('5h ····· — · sem leitura');
    expect(text).not.toMatch(/\b0%/);
    expect(model.tooltip).toContain('sem leitura');
    expect(model.tooltip).not.toContain('0%');
  });

  it('shows the credential warning even when no account has a reading', () => {
    const snap = snapshot(
      [entry({ id: 'k', adapterId: 'kimi', label: 'Kimi', windows: [], excludedReason: 'no-credential' })],
      { statusBarEntryIds: [] },
    );
    const text = flat(buildRedlineTrayModel(snap, NOW).items);
    expect(text).toContain('Kimi');
    expect(text).toContain('Sem credencial');
    expect(text).toContain('Sem leitura de cota');
  });
});

describe('buildRedlineTrayModel — normal snapshot', () => {
  const claude = entry({
    id: 'claude:a',
    label: 'Claude Pessoal',
    active: true,
    emailMasked: 'gu****@g**.com',
    windows: [
      win({ kind: 'hours', label: '5 Horas', usedRatio: 0.62, resetsAt: NOW + HOUR + 20 * MIN }),
      win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.4, resetsAt: NOW + 3 * 24 * HOUR }),
    ],
  });
  const codex = entry({
    id: 'codex:b',
    adapterId: 'codex',
    label: 'Codex',
    windows: [win({ kind: 'weekly', label: 'Semanal', usedRatio: 0.1 })],
  });
  const snap = snapshot([claude, codex], {
    ranking: {
      codex: [{ entryId: 'codex:b', adapterId: 'codex', label: 'Codex', headroom: 0.9 }],
      claude: [{ entryId: 'claude:a', adapterId: 'claude', label: 'Claude Pessoal', headroom: 0.3 }],
    },
  });
  const model = buildRedlineTrayModel(snap, NOW);
  const lines = texts(model.items);

  it('header line is the worst window with the urgency word', () => {
    expect(lines[0]).toBe('Redline · pior janela 62% (5h) em Claude Pessoal · atenção');
    expect(model.urgency).toBe('warn');
  });

  it('second line states freshness with provider and account counts', () => {
    expect(lines[1]).toBe('  2 provedores · 2 contas · atualizado agora mesmo');
  });

  it('renders window rows like the brief', () => {
    expect(lines).toContain('  5h ▮▮▮▯▯ 62% · reset em 1h20');
    expect(lines).toContain('  semana ▮▮▯▯▯ 40% · reset em 3d');
    expect(lines).toContain('  semana ▮▯▯▯▯ 10%');
  });

  it('marks the active and the recommended account', () => {
    expect(lines).toContain('Claude Pessoal · ativa');
    expect(lines).toContain('Codex · recomendada ★');
  });

  it('shows the masked email under the account, only masked', () => {
    expect(lines).toContain('  gu****@g**.com');
  });

  it('does not repeat the email when the label already carries it', () => {
    const labelled = entry({ label: 'Claude gu****@g**.com', emailMasked: 'gu****@g**.com' });
    const lines = texts(buildRedlineTrayModel(snapshot([labelled]), NOW).items);
    expect(lines).toContain('Claude gu****@g**.com');
    expect(lines).not.toContain('  gu****@g**.com');
  });

  it('ends with the three actions in order', () => {
    const tail = model.items.slice(-5);
    expect(tail.map((i) => (i.kind === 'action' ? i.action : i.kind))).toEqual([
      'separator',
      'refresh',
      'open-quota',
      'separator',
      'hide',
    ]);
    expect(flat(tail)).toContain('Atualizar agora');
    expect(flat(tail)).toContain('Abrir cotas no Nexus');
    expect(flat(tail)).toContain('Ocultar da bandeja');
  });

  it('flags a stale snapshot in words, in the tooltip and in the freshness line', () => {
    const old = buildRedlineTrayModel({ ...snap, updatedAt: NOW - 25 * MIN }, NOW);
    expect(old.stale).toBe(true);
    expect(texts(old.items)[1]).toBe(
      '  2 provedores · 2 contas · atualizado há 25 min · leitura desatualizada',
    );
    expect(old.tooltip).toContain('leitura desatualizada');
    expect(buildRedlineTrayModel(snap, NOW).stale).toBe(false);
  });

  it('tooltip is short and informative', () => {
    expect(model.tooltip).toBe('Nexus Redline · 2 contas · 62% em Claude Pessoal · agora mesmo');
    expect(Array.from(model.tooltip).length).toBeLessThanOrEqual(120);
  });

  it('shows an expired reset as "reset agora"', () => {
    const expired = entry({
      windows: [win({ kind: 'hours', label: '5 Horas', usedRatio: 0.95, resetsAt: NOW - HOUR })],
    });
    const m = buildRedlineTrayModel(snapshot([expired]), NOW);
    expect(texts(m.items)).toContain('  5h ▮▮▮▮▮ 95% · reset agora');
    expect(m.urgency).toBe('danger');
  });

  it('shows singular wording for one provider and one account', () => {
    const m = buildRedlineTrayModel(snapshot([entry()]), NOW);
    expect(texts(m.items)[1]).toBe('  1 provedor · 1 conta · atualizado agora mesmo');
    expect(m.tooltip).toContain('1 conta');
  });

  it('caps the windows listed per account', () => {
    const many = entry({
      windows: Array.from({ length: 9 }, (_, i) => win({ label: `Janela ${i}`, usedRatio: 0.1 })),
    });
    const rows = texts(buildRedlineTrayModel(snapshot([many]), NOW).items).filter((t) =>
      t.startsWith('  Janela'),
    );
    expect(rows).toHaveLength(4);
  });

  it('clips a very long label in the header line', () => {
    const long = entry({ label: 'Claude ' + 'muito longo '.repeat(30), windows: [win({ usedRatio: 0.9 })] });
    const header = texts(buildRedlineTrayModel(snapshot([long]), NOW).items)[0];
    expect(Array.from(header).length).toBeLessThan(120);
    expect(header).toContain('…');
  });
});

describe('buildRedlineTrayModel — many accounts', () => {
  const make = (n: number): RedlineEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry({
        id: `claude:${i}`,
        label: `Conta ${i}`,
        windows: [win({ usedRatio: Math.max(0, 0.95 - i * 0.01) })],
      }),
    );

  it('lists only the status-bar accounts and folds the rest into a submenu', () => {
    const entries = make(10);
    const snap = snapshot(entries, {
      statusBarEntryIds: entries.slice(0, 6).map((e) => e.id),
    });
    const model = buildRedlineTrayModel(snap, NOW);
    const submenu = model.items.find((i) => i.kind === 'submenu');
    expect(submenu).toBeDefined();
    expect(submenu && submenu.kind === 'submenu' ? submenu.text : '').toBe('Outras contas (4)');
    const top = model.items.filter((i) => i.kind === 'info').map((i) => (i.kind === 'info' ? i.text : ''));
    expect(top.filter((t) => /^Claude · Conta \d+$/.test(t))).toHaveLength(6);
    expect(submenu && submenu.kind === 'submenu' ? submenu.items : []).toHaveLength(4);
  });

  it('caps the submenu and says how many were left out', () => {
    const entries = make(120);
    const snap = snapshot(entries, { statusBarEntryIds: [entries[0].id] });
    const submenu = buildRedlineTrayModel(snap, NOW).items.find((i) => i.kind === 'submenu');
    expect(submenu && submenu.kind === 'submenu' ? submenu.items.length : 0).toBe(26);
    const last = submenu && submenu.kind === 'submenu' ? submenu.items.at(-1) : undefined;
    expect(last && last.kind === 'info' ? last.text : '').toBe('… e mais 94');
  });

  it('other-account lines carry the peak reading and state, never 0% for unknown', () => {
    const entries = [
      entry({ id: 'top', label: 'Topo', windows: [win({ usedRatio: 0.9 })] }),
      entry({ id: 'u', adapterId: 'kimi', label: 'Kimi', windows: [win({ usedRatio: null })], excludedReason: 'needs-relogin' }),
      entry({
        id: 'cd',
        adapterId: 'codex',
        label: 'Codex 2',
        windows: [win({ kind: 'hours', label: '5 Horas', usedRatio: 0.3 })],
        onCooldown: true,
        cooldownUntil: NOW + 12 * MIN,
      }),
    ];
    const snap = snapshot(entries, { statusBarEntryIds: ['top'] });
    const submenu = buildRedlineTrayModel(snap, NOW).items.find((i) => i.kind === 'submenu');
    const lines = submenu && submenu.kind === 'submenu' ? texts(submenu.items) : [];
    expect(lines).toEqual([
      'Kimi · sem leitura · Sessão expirada',
      'Codex 2 · 30% 5h · Em espera · 12m',
    ]);
  });

  it('the recommended mark is skipped when that account is not in the shown list', () => {
    const entries = make(8);
    const snap = snapshot(entries, {
      statusBarEntryIds: [entries[0].id],
      ranking: { claude: [{ entryId: 'claude:7', adapterId: 'claude', label: 'x', headroom: 0.99 }] },
    });
    expect(flat(buildRedlineTrayModel(snap, NOW).items.slice(0, 12))).not.toContain('recomendada');
  });
});

describe('buildRedlineTrayModel — hostile input goes through the parser', () => {
  function fromFile(raw: unknown): ReturnType<typeof buildRedlineTrayModel> {
    const parsed = parseRedlineSnapshot(JSON.stringify(raw));
    return buildRedlineTrayModel(parsed, NOW);
  }

  const base = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
    formatVersion: 1,
    generatedBy: 'nexus',
    updatedAt: NOW,
    entries,
    ranking: {},
    statusBarEntryIds: [],
    ...extra,
  });

  it('a raw email in any label never reaches the menu or the tooltip', () => {
    const model = fromFile(
      base([
        {
          id: 'a',
          adapterId: 'claude',
          label: 'Claude gustavo@gmail.com',
          emailMasked: 'gustavo@gmail.com',
          windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.9 }],
        },
      ]),
    );
    const all = `${flat(model.items)}\n${model.tooltip}`;
    expect(all).not.toContain('gustavo@gmail.com');
    expect(all).toContain('gu****@g**.com');
  });

  it('a corrupt or truncated file becomes the no-data model, not an exception', () => {
    expect(buildRedlineTrayModel(parseRedlineSnapshot('{"formatVersion":1,"entries":['), NOW).hasData).toBe(false);
    expect(buildRedlineTrayModel(parseRedlineSnapshot('\u0000\u0001'), NOW).hasData).toBe(false);
  });

  it('control characters and bidi overrides in labels are stripped from the menu', () => {
    const model = fromFile(
      base([
        {
          id: 'a',
          adapterId: 'claude',
          label: 'Cla\u202Eude\u0007\nLinha2',
          windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.5 }],
        },
      ]),
    );
    const all = flat(model.items);
    expect(all).not.toMatch(/[\u202E\u0007]/);
    expect(all).not.toContain('\nLinha2');
  });

  it('absurd readings are bounded: above 100% shows 100%, negative shows the dash', () => {
    const model = fromFile(
      base([
        {
          id: 'a',
          adapterId: 'claude',
          label: 'Claude',
          windows: [
            { kind: 'weekly', label: 'Semanal', usedRatio: 9999 },
            { kind: 'hours', label: '5 Horas', usedRatio: -3 },
          ],
        },
      ]),
    );
    const text = flat(model.items);
    expect(text).toContain('100%');
    expect(text).toContain('5h ····· — · sem leitura');
    expect(text).not.toContain('9999');
  });

  it('a huge file is refused instead of rendered', () => {
    const huge = base([{ id: 'a', adapterId: 'claude', windows: [] }], { pad: 'x'.repeat(1_100_000) });
    expect(buildRedlineTrayModel(parseRedlineSnapshot(JSON.stringify(huge)), NOW).hasData).toBe(false);
  });
});
