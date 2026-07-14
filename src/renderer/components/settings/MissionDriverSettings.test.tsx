/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import { MissionDriverSettings } from './MissionDriverSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MissionDriverSettings />));
  return { host, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MissionDriverSettings', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('loads an explicit shadow opt-out and persists the active opt-in', async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      missionDriverActiveMode: false,
    };
    const orchSet = vi.fn(async (patch: Partial<OrchSettings>) => {
      saved = { ...saved, ...patch };
      return saved;
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet,
        },
      },
    });
    const { host, root } = mount();
    await flushEffects();

    const toggle = host.querySelector<HTMLInputElement>(
      'input[aria-label="Ativar Mission Driver"]',
    );
    expect(toggle?.checked).toBe(false);
    expect(host.textContent).toContain('Próxima inicialização: Shadow');

    await act(async () => {
      toggle!.click();
      await Promise.resolve();
    });

    expect(orchSet).toHaveBeenCalledWith({ missionDriverActiveMode: true });
    expect(toggle?.checked).toBe(true);
    expect(host.textContent).toContain('Próxima inicialização: Ativo');
    expect(host.textContent).toContain('runtime atual não muda');
    expect(host.textContent).toContain('reiniciar');
    act(() => root.unmount());
  });

  it('rolls back the toggle when persistence fails', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => ({
            ...DEFAULT_ORCH_SETTINGS,
            missionDriverActiveMode: false,
          })),
          orchSet: vi.fn(async () => {
            throw new Error('disk full');
          }),
        },
      },
    });
    const { host, root } = mount();
    await flushEffects();
    const toggle = host.querySelector<HTMLInputElement>(
      'input[aria-label="Ativar Mission Driver"]',
    );

    await act(async () => {
      toggle!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toggle?.checked).toBe(false);
    expect(host.textContent).toContain('disk full');
    act(() => root.unmount());
  });
});
