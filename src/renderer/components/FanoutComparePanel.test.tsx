/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FanoutComparePanel } from './FanoutComparePanel';
import { useOrchStore } from '../state/orch-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const initial = useOrchStore.getState();

function mount(summaries: readonly string[]): HTMLElement {
  useOrchStore.setState({
    missions: [{ id: 'm1', createdAt: 1, updatedAt: 2 }],
    handoffs: summaries.map((summary, i) => ({
      id: `h${i}`,
      missionId: 'm1',
      fromAgent: `agente-${i}`,
      summary,
      status: 'success',
      createdAt: 10 + i,
    })),
  } as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<FanoutComparePanel />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  useOrchStore.setState(initial, true);
});

describe('FanoutComparePanel', () => {
  it('mostra o resumo do handoff com marcas inline, dentro do cartão cortado', () => {
    const host = mount(['Feito com **cuidado** e `npm test`; *ok*', 'sem marcas']);
    const summaries = host.querySelectorAll('p.fanout__summary');
    expect(summaries).toHaveLength(2);
    const marked = [...summaries].find((p) => p.textContent?.includes('cuidado'))!;
    expect(marked.querySelector('.composer-rich-text .rt-bold')?.textContent).toBe('cuidado');
    expect(marked.querySelector('code.rt-code')?.textContent).toBe('npm test');
    expect(marked.querySelector('.rt-italic')?.textContent).toBe('ok');
    expect(marked.textContent).toBe('Feito com cuidado e npm test; ok');
    // Só marcas inline: nada de bloco que quebraria o corte de 4 linhas.
    expect(marked.querySelector('pre, ul, ol, h1, h2, h3, table, p')).toBeNull();
  });

  it('HTML do agente fica texto e resumo vazio vira travessão', () => {
    const host = mount(['<img src=x onerror=alert(1)>', '']);
    expect(host.querySelector('img')).toBeNull();
    const texts = [...host.querySelectorAll('p.fanout__summary')].map((p) => p.textContent);
    expect(texts).toContain('<img src=x onerror=alert(1)>');
    expect(texts).toContain('—');
  });
});
