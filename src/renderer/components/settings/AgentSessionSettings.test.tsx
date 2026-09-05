/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import { AgentSessionSettings } from './AgentSessionSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AgentSessionSettings />));
  return { host, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AgentSessionSettings', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('ignores the legacy Ralph flag and only offers working session controls', async () => {
    const legacy = { ...DEFAULT_ORCH_SETTINGS, missionDriverActiveMode: false };
    const orchSet = vi.fn(async (patch: Partial<OrchSettings>) => ({ ...legacy, ...patch }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { settings: { orchGet: vi.fn(async () => legacy), orchSet } },
    });
    const { host, root } = mount();
    await flushEffects();

    expect(host.textContent).not.toMatch(/Ralph|Mission Driver|Shadow/);
    expect(host.textContent).toContain('Retoma de agentes');
    expect(host.textContent).toContain('Prompts de boot');
    const pause = host.querySelector<HTMLInputElement>('input[value="pause"]');
    await act(async () => { pause!.click(); });
    expect(orchSet).toHaveBeenCalledWith({ agentRestorePolicy: 'pause' });
    expect(pause?.checked).toBe(true);
    act(() => root.unmount());
  });

  it('rolls back the toggle when persistence fails', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => ({
            ...DEFAULT_ORCH_SETTINGS,
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
      'input[aria-label="Autoaceitar prompts conhecidos"]',
    );

    await act(async () => {
      toggle!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toggle?.checked).toBe(true);
    expect(host.textContent).toContain('disk full');
    act(() => root.unmount());
  });

  it('exposes and persists the CLI prompt autoresponder kill switch', async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      cliPromptAutoResponderEnabled: false,
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
      'input[aria-label="Autoaceitar prompts conhecidos"]',
    );
    expect(toggle?.checked).toBe(false);
    expect(host.textContent).toContain('Kill switch ativo');

    await act(async () => {
      toggle!.click();
      await Promise.resolve();
    });

    expect(orchSet).toHaveBeenCalledWith({
      cliPromptAutoResponderEnabled: true,
    });
    expect(toggle?.checked).toBe(true);
    act(() => root.unmount());
  });
});
