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
  it('shows a recoverable load error instead of an endless loading message', async () => {
    const orchGet = vi.fn().mockRejectedValueOnce(new Error('Configuração indisponível')).mockResolvedValue(DEFAULT_ORCH_SETTINGS);
    Object.defineProperty(window, 'nexus', { configurable: true, value: { settings: { orchGet } } });
    const host = mount(); await flushEffects();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Configuração indisponível');
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Tentar novamente');
    expect(retry).toBeTruthy();
    act(() => retry!.click()); await flushEffects();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('Terminal da ferramenta');
  });
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

    expect(host.textContent).toContain('Conexão ACP');
    const acpButton = host.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]:not([title])',
    );
    expect(acpButton?.textContent).toBe('Conexão ACP');

    act(() => acpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();
    expect(orchSet).toHaveBeenCalledWith({ agentTransport: 'acp' });
    expect(host.textContent).toContain('Escolha um agente abaixo para usar a conexão ACP.');

    const selectButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.title === 'Usar este agente',
    );
    expect(selectButton).toBeDefined();
    act(() => selectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();
    expect(orchSet).toHaveBeenLastCalledWith({ acpHarnessId: 'claude' });
    expect(host.textContent).toContain('Agente escolhido: Claude Code (ACP)');
  });

  it('marks the active transport and explains terminal mode without ACP jargon', async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      agentTransport: 'cli-pty',
    };
    const orchSet = vi.fn(async (patch: Partial<OrchSettings>) => {
      saved = { ...saved, ...patch };
      return saved;
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { settings: { orchGet: vi.fn(async () => saved), orchSet } },
    });

    const host = mount();
    await flushEffects();

    // Terminal ativo: badge "Em uso" no card e status explícito no modo cli-pty.
    const activeOption = host.querySelector('.acp-harness__option--active');
    expect(activeOption?.textContent).toContain('Terminal da ferramenta');
    expect(activeOption?.textContent).toContain('Em uso');
    expect(host.querySelector('.acp-harness__status')?.textContent).toContain(
      'Os agentes abrem no terminal da própria ferramenta.',
    );

    const acpButton = host.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]:not([title])',
    );
    act(() => acpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();

    // ACP ativo: o selo migra de card e o catálogo mostra identidade visual.
    const options = [...host.querySelectorAll('.acp-harness__option')];
    expect(options[1]?.textContent).toContain('Em uso');
    expect(options[0]?.textContent).not.toContain('Em uso');
    expect(
      host.querySelectorAll('.acp-harness__list .provider-logo').length,
    ).toBeGreaterThan(0);
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
    const customDetails = host.querySelector<HTMLDetailsElement>('.acp-harness__custom');
    expect(customDetails?.open).toBe(false);
    act(() => customDetails!.querySelector('summary')!.click());
    expect(customDetails?.open).toBe(true);
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
      (button) => button.textContent?.includes('Salvar e usar definição'),
    );
    expect(saveButton).toBeDefined();
    act(() => saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();

    expect(orchSet).toHaveBeenCalledWith({
      acpCustomHarnesses: [expect.objectContaining({ id: 'local-runner' })],
      acpHarnessId: 'local-runner',
      agentTransport: 'acp',
    });
    expect(host.textContent).toContain('Agente escolhido: Runner local');
  });
});
