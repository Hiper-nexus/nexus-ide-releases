import { describe, expect, it } from 'vitest';
import type {
  RedlineEntry,
  RedlineSnapshotFile,
  RedlineWindow,
} from '../../shared/redline-types';
import {
  REDLINE_BAR_CLASS,
  buildRedlineBarOutput,
  formatRedlineBarJson,
} from './redline-bar';

const NOW = 1_780_000_000_000;
const MIN = 60_000;

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

describe('buildRedlineBarOutput', () => {
  it('mostra a pior janela da faixa com barra de 5 blocos e percentual', () => {
    const out = buildRedlineBarOutput(
      snapshot([
        entry({ id: 'claude:a', windows: [win({ usedRatio: 0.11 })] }),
        entry({ id: 'codex:a', adapterId: 'codex', label: 'Codex', windows: [win({ usedRatio: 0.87 })] }),
      ]),
      NOW,
    );
    expect(out.text).toBe('▮▮▮▮▯ 87%');
    expect(out.percentage).toBe(87);
    expect(out.class).toEqual([REDLINE_BAR_CLASS, 'danger', 'active']);
    expect(out.tooltip.split('\n')[0]).toContain('pior janela 87% (semana) em Codex');
  });

  it('atenção entre 60% e 85% destaca o módulo; abaixo de 60% não', () => {
    const warn = buildRedlineBarOutput(snapshot([entry({ windows: [win({ usedRatio: 0.6 })] })]), NOW);
    expect(warn.class).toEqual([REDLINE_BAR_CLASS, 'warn', 'active']);
    const ok = buildRedlineBarOutput(snapshot([entry({ windows: [win({ usedRatio: 0.59 })] })]), NOW);
    expect(ok.class).toEqual([REDLINE_BAR_CLASS, 'ok']);
    expect(ok.text).toBe('▮▮▮▯▯ 59%');
  });

  it('sem leitura é "—" e nunca 0%: percentage some do JSON', () => {
    const out = buildRedlineBarOutput(
      snapshot([entry({ windows: [win({ usedRatio: null })] })]),
      NOW,
    );
    expect(out.text).toBe('····· —');
    expect(out).not.toHaveProperty('percentage');
    expect(out.class).toEqual([REDLINE_BAR_CLASS, 'unknown']);
    expect(formatRedlineBarJson(out)).not.toContain('"percentage"');
    expect(out.text).not.toContain('0%');
  });

  it('0% medido de verdade continua sendo 0%', () => {
    const out = buildRedlineBarOutput(snapshot([entry({ windows: [win({ usedRatio: 0 })] })]), NOW);
    expect(out.text).toBe('▯▯▯▯▯ 0%');
    expect(out.percentage).toBe(0);
  });

  it('dado velho (mais de 10 min) ganha "?", classe stale e perde o destaque', () => {
    const out = buildRedlineBarOutput(
      snapshot([entry({ windows: [win({ usedRatio: 0.9 })] })], { updatedAt: NOW - 11 * MIN }),
      NOW,
    );
    expect(out.text).toBe('▮▮▮▮▮ 90%?');
    expect(out.class).toEqual([REDLINE_BAR_CLASS, 'danger', 'stale']);
    expect(out.tooltip).toContain('leitura desatualizada');
  });

  it('sem snapshot ou sem contas: texto neutro, sem percentual, explica no tooltip', () => {
    for (const none of [null, snapshot([])]) {
      const out = buildRedlineBarOutput(none, NOW);
      expect(out.text).toBe('Redline —');
      expect(out).not.toHaveProperty('percentage');
      expect(out.class).toEqual([REDLINE_BAR_CLASS, 'unknown', 'stale']);
      expect(out.tooltip).toContain('aguardando a primeira leitura');
    }
  });

  it('o tooltip lista cada conta da faixa, em várias linhas, e a dica de clique', () => {
    const out = buildRedlineBarOutput(
      snapshot([
        entry({ id: 'claude:a', label: 'Claude Pessoal', windows: [win({ usedRatio: 0.3, resetsAt: NOW + 5 * 60 * MIN })] }),
        entry({ id: 'codex:a', adapterId: 'codex', label: 'Codex', windows: [win({ usedRatio: 0.5 })] }),
      ]),
      NOW,
    );
    const lines = out.tooltip.split('\n');
    expect(lines.some((l) => l.startsWith('Claude'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Codex'))).toBe(true);
    expect(lines.some((l) => l.includes('semana') && l.includes('30%'))).toBe(true);
    expect(lines.at(-1)).toBe('Clique para abrir as cotas no Nexus');
    // linhas de ação do menu da bandeja não vazam para o tooltip
    expect(out.tooltip).not.toContain('Atualizar agora');
    expect(out.tooltip).not.toContain('Ocultar da bandeja');
  });

  it('contas fora da faixa vão para um bloco recuado e o tooltip tem teto', () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry({
        id: `claude:${index}`,
        label: `Conta ${index}`,
        windows: [win({ usedRatio: index === 0 ? 0.7 : 0.1 })],
      }),
    );
    const out = buildRedlineBarOutput(snapshot(entries, { statusBarEntryIds: ['claude:0'] }), NOW);
    const lines = out.tooltip.split('\n');
    expect(lines.some((l) => l.startsWith('Outras contas (39)'))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(42);
    expect(out.tooltip.length).toBeLessThanOrEqual(2000);
  });

  it('e-mail já mascarado pelo parse nunca vira e-mail inteiro e o JSON é uma linha válida', () => {
    const out = buildRedlineBarOutput(
      snapshot([entry({ emailMasked: 'jo***@ex***.com', label: 'Conta "A"\\' })]),
      NOW,
    );
    const json = formatRedlineBarJson(out);
    expect(json.split('\n')).toHaveLength(1);
    const back = JSON.parse(json) as { text: string; tooltip: string; class: string[] };
    expect(back.tooltip).toContain('jo***@ex***.com');
    expect(back.tooltip).toContain('Conta "A"\\');
    expect(Array.isArray(back.class)).toBe(true);
  });
});
