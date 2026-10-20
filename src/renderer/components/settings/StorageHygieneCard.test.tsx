/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageHygieneReport } from '../../../shared/storage-hygiene';
import { formatSince, StorageHygieneCard } from './StorageHygieneCard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GiB = 1024 ** 3;
const roots: Root[] = [];

function reportFixture(overrides: Partial<StorageHygieneReport> = {}): StorageHygieneReport {
  return {
    disk: { freeBytes: 12 * GiB, totalBytes: 460 * GiB, sampledAt: Date.now() },
    pressure: 'low',
    categories: [
      { id: 'browser-profiles', label: 'Perfis do navegador', bytes: 0.3 * GiB, truncated: false, managed: true },
      { id: 'agent-worktrees', label: 'Worktrees e runtime dos projetos', bytes: 42 * GiB, truncated: true, managed: true },
      { id: 'agent-memory', label: 'Memória dos agentes', bytes: 0.01 * GiB, truncated: false, managed: false },
    ],
    measuredAt: Date.now() - 5 * 60_000,
    lastRun: {
      startedAt: Date.now() - 3 * 60 * 60_000,
      finishedAt: Date.now() - 3 * 60 * 60_000,
      trigger: 'scheduled',
      pressure: 'low',
      steps: [
        { id: 'agent-worktrees', label: 'Worktrees de agentes', removed: 7, freedBytes: 0, kept: 2,
          detail: '3 aparada(s), 2 aposentada(s) com salvaguarda' },
        { id: 'temp', label: 'Temporários abandonados', removed: 4, freedBytes: 2 * GiB, kept: 0 },
      ],
      freedBytes: 2 * GiB,
      diskFreeDeltaBytes: 30 * GiB,
    },
    running: false,
    nextRunAt: null,
    ...overrides,
  };
}

let report: ReturnType<typeof vi.fn>;
let cleanNow: ReturnType<typeof vi.fn>;

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<StorageHygieneCard />));
  return host;
}

beforeEach(() => {
  report = vi.fn(async () => reportFixture());
  cleanNow = vi.fn(async () => reportFixture({ pressure: 'ok', disk: { freeBytes: 120 * GiB, totalBytes: 460 * GiB, sampledAt: 1 } }));
  (window as unknown as { nexus: unknown }).nexus = { storage: { report, cleanNow } };
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  delete (window as unknown as { nexus?: unknown }).nexus;
});

describe('StorageHygieneCard', () => {
  it('diz o estado em texto, a folga, o uso por categoria (maior primeiro) e a última limpeza', async () => {
    const host = await render();
    expect(host.textContent).toContain('Disco apertado.');
    expect(host.textContent).toContain('12 GB livres de 460 GB');
    const rows = [...host.querySelectorAll('.storage-hygiene__row')].map((row) => row.textContent);
    expect(rows[0]).toContain('Worktrees e runtime dos projetos');
    expect(rows[0]).toContain('mais de 42 GB');
    expect(rows.at(-1)).toContain('mantido');
    // Liberado = o maior entre o medido e o ganho do volume.
    expect(host.textContent).toContain('11 item(ns) removido(s) · 30 GB liberados');
    expect(host.textContent).toContain('2 aposentada(s) com salvaguarda');
    expect(host.querySelector('.ops-metric--warn')).not.toBeNull();
  });

  it('"Limpar agora" roda a limpeza e mostra o relatório novo', async () => {
    const host = await render();
    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === 'Limpar agora')!;
    await act(async () => {
      button.click();
    });
    expect(cleanNow).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Disco com folga.');
  });

  it('rodada em curso desabilita o botão', async () => {
    report.mockResolvedValue(reportFixture({ running: true }));
    const host = await render();
    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === 'Limpando…');
    expect(button?.disabled).toBe(true);
  });

  it('formatSince fala em minutos, horas e dias', () => {
    const now = 10 * 24 * 60 * 60_000;
    expect(formatSince(null, now)).toBe('nunca');
    expect(formatSince(now - 10_000, now)).toBe('agora');
    expect(formatSince(now - 15 * 60_000, now)).toBe('há 15 min');
    expect(formatSince(now - 5 * 60 * 60_000, now)).toBe('há 5 h');
    expect(formatSince(now - 3 * 24 * 60 * 60_000, now)).toBe('há 3 dias');
  });
});
