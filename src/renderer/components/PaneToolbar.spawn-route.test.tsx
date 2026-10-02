/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';

vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: vi.fn(),
  wakeHost: vi.fn(),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => 'session-a'),
  onPaneSessionChange: vi.fn(() => vi.fn()),
}));
vi.mock('../state/confirm-store', () => ({ askConfirm: vi.fn(async () => true) }));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({
  AgentAvatar: () => null,
  resolveAgentCategory: () => undefined,
}));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { PaneToolbar } from './PaneToolbar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(pane: PaneModel): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  return host;
}

describe('PaneToolbar — chip da rota do spawn', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const base: PaneModel = { id: 'p1', kind: 'cli-agent', title: 'Helper', adapterId: 'codex' };

  it('rota do Jev mostra "Jev"', () => {
    const host = mount({ ...base, spawnRoute: { source: 'jev' } });
    expect(host.textContent).toContain('Jev');
    expect(host.innerHTML).toContain('CLI escolhida pelo Jev');
  });

  it('com confiança e o que a regra escolheria, o tooltip e o aria-label dizem; o chip segue discreto', () => {
    const host = mount({
      ...base,
      spawnRoute: {
        source: 'jev',
        confidence: { tier: 0.82, specialty: 0.71 },
        ruleChoice: { adapterId: 'claude', model: 'sonnet' },
      },
    });
    const chip = host.querySelector('[data-rota-chip="jev"]')!;
    const expected =
      'CLI escolhida pelo Jev (confiança: tarefa 0,82 · especialidade 0,71). A regra teria escolhido: claude/sonnet.';
    expect(chip.getAttribute('data-tip')).toBe(expected);
    expect(chip.getAttribute('aria-label')).toBe(expected);
    // O cabeçalho não cresce: o rótulo visível continua só "Jev".
    expect(chip.textContent).toBe('Jev');
  });

  it('o Jev concordou com a regra: o tooltip diz "o mesmo"; só inclui o que existe', () => {
    const same = mount({ ...base, spawnRoute: { source: 'mixed', ruleChoice: 'same' } });
    expect(same.querySelector('[data-rota-chip="jev"]')!.getAttribute('data-tip')).toBe(
      'CLI escolhida pelo Jev. A regra teria escolhido o mesmo.',
    );
    const onlyConfidence = mount({ ...base, spawnRoute: { source: 'jev', confidence: { effort: 0.6 } } });
    expect(onlyConfidence.querySelector('[data-rota-chip="jev"]')!.getAttribute('data-tip')).toBe(
      'CLI escolhida pelo Jev (confiança: esforço 0,60).',
    );
  });

  it('queda continua igual mesmo se o objeto trouxer confiança/regra', () => {
    const host = mount({
      ...base,
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key', confidence: { tier: 0.9 }, ruleChoice: 'same' },
    });
    const chip = host.querySelector('[data-rota-chip="fallback"]')!;
    expect(chip.getAttribute('data-tip')).toBe('CLI escolhida pela heurística — Jev sem chave');
    expect(host.innerHTML).not.toContain('A regra teria escolhido');
  });

  it('queda mostra "sem Jev" com o motivo no tooltip', () => {
    const host = mount({ ...base, spawnRoute: { source: 'heuristic', jevUnavailable: 'timeout' } });
    expect(host.textContent).toContain('sem Jev');
    expect(host.innerHTML).toContain('tempo esgotado');
  });

  it('heurística sem queda (Jev pouco confiante) e pane sem rota não mostram chip', () => {
    expect(mount({ ...base, spawnRoute: { source: 'heuristic' } }).innerHTML).not.toContain('rota-chip');
    expect(mount(base).innerHTML).not.toContain('rota-chip');
  });
});
