/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CalibrateDecisionModels } from './CalibrateDecisionModels';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('F-1378: não confirma calibração depois de sair do Automático', async () => {
  const calibrate = vi.fn(async () => ({ ok: true, models: [], written: true }));
  const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');
  Object.defineProperty(window, 'nexus', { configurable: true, value: { decisionModels: {
    calibrate,
    calibrationPlan: vi.fn(async () => ({ ok: true, runnable: true, cases: 20, estimatedUsd: 0.0021, models: [] })),
  } } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)!;
  try {
    await act(async () => { root.render(<CalibrateDecisionModels mode="auto" />); });
    await act(async () => { button('Calibrar modelos').click(); });
    expect(button('Calibrar agora').disabled).toBe(false);
    await act(async () => { root.render(<CalibrateDecisionModels mode="jev" />); });
    await act(async () => { button('Calibrar agora').click(); });
    expect(calibrate).not.toHaveBeenCalled();
    expect(button('Calibrar agora').disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
    else Reflect.deleteProperty(window, 'nexus');
  }
});
