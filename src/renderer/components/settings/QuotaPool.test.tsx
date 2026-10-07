/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderQuotaEntry, QuotaWindow } from '../../../shared/quota-types';
import { QuotaPoolSection } from './QuotaPool';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse('2026-09-03T12:00:00.000Z');
const HOUR = 60 * 60_000;

const fiveHours = (usedRatio: number | null, resetsAt?: number): QuotaWindow => ({
  kind: 'hours',
  label: '5 Horas',
  usedRatio,
  source: usedRatio === null ? 'unknown' : 'provider-api',
  confidence: usedRatio === null ? 'low' : 'high',
  ...(resetsAt !== undefined ? { resetsAt } : {}),
});

const codex = (accountId: string, label: string, windows: QuotaWindow[]): ProviderQuotaEntry => ({
  id: `codex:${accountId}`,
  adapterId: 'codex',
  accountId,
  label: `Codex · ${label}`,
  installed: true,
  onCooldown: false,
  windows,
  updatedAt: now,
});

let root: Root | null = null;
function render(entries: ProviderQuotaEntry[]): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<QuotaPoolSection entries={entries} now={now} supplierLabels={{ glm: 'GLM' }} />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('QuotaPoolSection', () => {
  it('mostra o que resta no conjunto e a parcela da próxima renovação', () => {
    const host = render([
      codex('a', 'Pessoal', [fiveHours(0.8, now + HOUR)]),
      codex('b', 'Trabalho', [fiveHours(0.4, now + 3 * HOUR)]),
    ]);
    expect(host.querySelector('#quota-pool-title')?.textContent).toBe('Folga conjunta por ferramenta');
    expect(host.querySelector('[data-pool-adapter="codex"] .quota-pool__group-title')?.textContent).toContain('Codex');
    expect(host.querySelector('.quota-pool__number')?.textContent).toBe('40% restante');
    expect(host.querySelector('.quota-pool__coverage')?.textContent).toBe('2 contas somadas');
    expect(host.querySelector('.quota-pool__refill')?.textContent).toBe('Próxima renovação devolve +40% em 1h');
    const segments = [...host.querySelectorAll('.quota-pool__bar > li')].map((li) => li.getAttribute('title'));
    expect(segments).toEqual(['Pessoal: 20% restante, renova em 1h', 'Trabalho: 60% restante, renova em 3h']);
  });

  it('mantém a coluna da conta sem leitura com "—", sem preenchimento e fora da soma', () => {
    const host = render([
      codex('a', 'Pessoal', [fiveHours(0.6, now + HOUR)]),
      codex('b', 'Reserva', [fiveHours(null)]),
    ]);
    expect(host.querySelector('.quota-pool__number')?.textContent).toBe('40% restante');
    expect(host.querySelector('.quota-pool__coverage')?.textContent).toBe('1 de 2 contas com leitura');
    const unknown = host.querySelector('.quota-pool__segment--unknown');
    expect(unknown?.getAttribute('title')).toBe('Reserva: sem leitura desta janela');
    expect(unknown?.querySelector('.quota-pool__fill')).toBeNull();
    expect(unknown?.textContent).toContain('—');
    expect(host.querySelectorAll('.quota-pool__bar > li')).toHaveLength(2);
  });

  it('mascara e-mail no rótulo da conta e não deriva iniciais dele', () => {
    const host = render([
      codex('a', 'gustavo@example.com', [fiveHours(0.5)]),
      codex('b', 'Trabalho', [fiveHours(0.5)]),
    ]);
    expect(host.textContent).not.toContain('gustavo@example.com');
    expect(host.textContent).toContain('g•••@e•••.com');
    expect(host.querySelector('.quota-pool__bar')?.textContent).not.toMatch(/\bGE\b/);
  });

  it('não aparece com uma conta só nem sem leitura conhecida', () => {
    expect(render([codex('a', 'Pessoal', [fiveHours(0.5)])]).querySelector('.quota-pool')).toBeNull();
    act(() => root?.unmount());
    expect(
      render([codex('a', 'Pessoal', [fiveHours(null)]), codex('b', 'Trabalho', [fiveHours(null)])])
        .querySelector('.quota-pool'),
    ).toBeNull();
  });
});
