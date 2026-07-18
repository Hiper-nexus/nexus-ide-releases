/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import type { AdapterInfo } from '../../../shared/types';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import { OrchestratorDefaults } from './OrchestratorDefaults';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function adapter(
  id: string,
  label: string,
  models: string[],
  installed = true,
): AdapterInfo {
  return {
    id,
    kind: 'cli-pty',
    label,
    icon: id.slice(0, 1),
    models: { list: models, default: models[0] ?? '' },
    installed,
    orchestratorCapable: id !== 'aider',
    installCommand: '',
    idleTimeoutMs: 800,
  };
}

function account(id: string, adapterId: string, label: string): AccountInfo {
  return {
    id,
    adapterId,
    label,
    mode: 'subscription',
    upstream: adapterId,
    createdAt: 1,
    active: false,
    hasCredential: true,
    onCooldown: false,
  };
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<OrchestratorDefaults />));
  return { host, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('OrchestratorDefaults', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('configures provider, model and account from the installed MCP-capable inventory', async () => {
    let saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      missionDriverActiveMode: false,
      defaultAdapterId: 'codex',
      defaultModel: 'gpt-5.4',
      defaultAccountId: 'codex-work',
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
        adapters: {
          list: vi.fn(async () => [
            adapter('claude', 'Claude', ['claude-sonnet']),
            adapter('codex', 'Codex', ['gpt-5.4', 'gpt-5.3-codex']),
            adapter('agy', 'Gemini', ['gemini-3.1-pro'], false),
            adapter('grok', 'Grok', ['grok-code']),
            adapter('aider', 'Aider', ['aider-default']),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => [
            account('claude-work', 'claude', 'Claude trabalho'),
            account('codex-work', 'codex', 'Codex trabalho'),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    const provider = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Provider do orquestrador"]',
    );
    const model = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Modelo do orquestrador"]',
    );
    const accountSelect = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Conta do orquestrador"]',
    );
    expect(provider?.value).toBe('codex');
    expect([...provider!.options].map((option) => option.text)).toEqual([
      'Claude',
      'Codex',
      'Grok',
    ]);
    expect([...model!.options].map((option) => option.value)).toEqual([
      '',
      'gpt-5.4',
      'gpt-5.3-codex',
    ]);
    expect([...accountSelect!.options].map((option) => option.value)).toEqual([
      '',
      'codex-work',
    ]);
    expect(host.textContent).toContain('Codex · MCP conectado');

    await act(async () => {
      provider!.value = 'claude';
      provider!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(orchSet).toHaveBeenCalledWith({
      defaultAdapterId: 'claude',
      defaultModel: '',
      defaultAccountId: '',
    });
    expect([...model!.options].map((option) => option.value)).toEqual([
      '',
      'claude-sonnet',
    ]);
    expect([...accountSelect!.options].map((option) => option.value)).toEqual([
      '',
      'claude-work',
    ]);
    act(() => root.unmount());
  });

  it('keeps an unavailable saved provider visible instead of silently changing it', async () => {
    const saved: OrchSettings = {
      ...DEFAULT_ORCH_SETTINGS,
      missionDriverActiveMode: false,
      defaultAdapterId: 'claude',
      defaultModel: '',
      defaultAccountId: '',
    };
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        settings: {
          orchGet: vi.fn(async () => saved),
          orchSet: vi.fn(async () => saved),
        },
        adapters: {
          list: vi.fn(async () => [
            adapter('claude', 'Claude', ['claude-sonnet'], false),
            adapter('codex', 'Codex', ['gpt-5.4']),
          ]),
          onChanged: vi.fn(() => vi.fn()),
        },
        accounts: {
          list: vi.fn(async () => []),
          onChanged: vi.fn(() => vi.fn()),
        },
      },
    });

    const { host, root } = mount();
    await flushEffects();

    const provider = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Provider do orquestrador"]',
    );
    expect(provider?.value).toBe('claude');
    expect(provider?.selectedOptions[0]?.text).toContain('indisponível');
    expect(host.textContent).toContain('Instale ou escolha outro provider');
    act(() => root.unmount());
  });
});
