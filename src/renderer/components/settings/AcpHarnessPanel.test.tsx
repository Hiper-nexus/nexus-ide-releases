/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import { AcpHarnessPanel } from './AcpHarnessPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<AcpHarnessPanel />));
  return host;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'nexus');
  vi.restoreAllMocks();
});

describe('AcpHarnessPanel', () => {
  it('persists transport and harness selection through the real settings bridge', async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      agentTransport: 'cli-pty',
    };
    const orchSet = vi.fn(async (patch: Partial<OrchSettings>) => {
      saved = { ...saved, ...patch };
      return saved;
    });
    const orchGet = vi.fn(async () => saved);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { settings: { orchGet, orchSet } },
    });

    const host = mount();
    await flushEffects();

    expect(host.textContent).toContain('Runtime ACP');
    const acpButton = host.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]:not([title])',
    );
    expect(acpButton?.textContent).toBe('ACP');

    act(() => acpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();
    expect(orchSet).toHaveBeenCalledWith({ agentTransport: 'acp' });
    expect(host.textContent).toContain('Selecione um harness para liberar o spawn ACP.');

    const selectButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.title === 'Usar este harness no dispatch',
    );
    expect(selectButton).toBeDefined();
    act(() => selectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();
    expect(orchSet).toHaveBeenLastCalledWith({ acpHarnessId: 'claude' });
    expect(host.textContent).toContain('Harness ativo: Claude Code (ACP)');
  });

  it('validates and saves a custom BYOH definition instead of only editing local state', async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      agentTransport: 'acp',
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

    const host = mount();
    await flushEffects();
    const editor = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="JSON do harness custom"]',
    );
    expect(editor).toBeDefined();
    const definition = JSON.stringify({
      id: 'local-runner',
      label: 'Runner local',
      command: 'runner-acp',
      args: ['--stdio'],
    });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!setter) throw new Error('textarea value setter unavailable');
      setter.call(editor, definition);
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Validar e salvar'),
    );
    expect(saveButton).toBeDefined();
    act(() => saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();

    expect(orchSet).toHaveBeenCalledWith({
      acpCustomHarnesses: [expect.objectContaining({ id: 'local-runner' })],
      acpHarnessId: 'local-runner',
      agentTransport: 'acp',
    });
    expect(host.textContent).toContain('Harness ativo: Runner local');
  });
});
