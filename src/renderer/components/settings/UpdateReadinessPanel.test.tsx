/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { UpdateReadinessPanel } from './UpdateReadinessPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('recovers a failed update status query without trapping the user in loading', async () => {
  const readiness = vi.fn().mockRejectedValueOnce(new Error('private transport')).mockResolvedValue({ appVersion: '1.0.0', checks: [] });
  const state = { phase: 'uptodate', currentVersion: '1.0.0', source: 'none', canInstall: false };
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    ops: { releaseReadiness: readiness },
    update: { getState: vi.fn(async () => state), check: vi.fn(async () => state), onState: vi.fn(() => () => {}) },
  } });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<UpdateReadinessPanel />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível');
    expect(host.textContent).not.toContain('private transport');
    await act(async () => host.querySelector('button')?.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('App atualizado');
  } finally {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'nexus');
  }
});
