/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Squad } from '../../shared/orch-types';
import type { AdapterInfo } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { useProviderStore } from '../state/provider-store';
import { SquadEditor } from './SquadEditor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const builtin: Squad = {
  id: 'nexus-full',
  name: 'Full-Stack',
  createdAt: '1',
  builtin: true,
  orchestratorInstructions: 'orquestre',
  agents: [
    { id: 'orch', agentName: 'Maestro', category: 'orchestrator', cli: 'claude', model: 'claude-sonnet-5', allowedTools: null },
  ],
};

function stubNexus(saveSquad: (squad: Squad) => Promise<{ ok: boolean; error?: string }>) {
  // jsdom já provê window.crypto.randomUUID; só injetamos a ponte nexus.
  (window as unknown as { nexus: unknown }).nexus = {
    adapters: { list: vi.fn(async () => []) },
    orch: { saveSquad },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SquadEditor', () => {
  it('salvar um builtin envia uma CÓPIA (id novo, builtin=false) via saveSquad', async () => {
    const saveSquad = vi.fn(async (_squad: Squad) => ({ ok: true as const }));
    stubNexus(saveSquad);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <SquadEditor squad={builtin} onClose={vi.fn()} onSaved={vi.fn()} />,
      );
    });

    const saveBtn = [...document.body.querySelectorAll('button')].find((b) =>
      /criar cópia|salvar/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn.click();
    });

    expect(saveSquad).toHaveBeenCalledTimes(1);
    const payload = saveSquad.mock.calls[0]![0];
    expect(payload.builtin).toBe(false);
    expect(payload.id).not.toBe('nexus-full');
    expect(payload.name).toBe('Full-Stack');
    act(() => root.unmount());
  });

  it('bloqueia modelo sem sessão e escolhe o primeiro usável ao trocar de CLI', async () => {
    const adapters: AdapterInfo[] = [
      {
        id: 'claude',
        kind: 'cli-pty',
        label: 'Claude',
        icon: '◆',
        models: { list: ['sonnet', 'opus'], default: 'sonnet' },
        installed: true,
        installCommand: '',
        idleTimeoutMs: 800,
        orchestratorCapable: true,
      },
      {
        id: 'codex',
        kind: 'cli-pty',
        label: 'Codex',
        icon: '⬡',
        models: { list: ['gpt-x'], default: 'gpt-x' },
        installed: true,
        installCommand: '',
        idleTimeoutMs: 800,
        orchestratorCapable: true,
      },
    ];
    const provider = (
      adapterId: string,
      overrides: Partial<ProviderSettingsInfo> = {},
    ): ProviderSettingsInfo => ({
      adapterId,
      label: adapterId,
      icon: '?',
      kind: 'cli-pty',
      enabled: true,
      installed: true,
      canAutoInstall: false,
      binPath: '',
      detectedBin: adapterId,
      defaultModel: '',
      models: [],
      extraArgs: [],
      keyEnvVar: null,
      hasKey: false,
      keyMasked: null,
      authMethod: 'oauth',
      secureStorageAvailable: true,
      authStrategy: 'subscription',
      upstream: adapterId,
      routable: false,
      upstreams: [],
      permissionMode: '',
      permissionModes: [],
      effort: '',
      efforts: [],
      verbose: false,
      supportsVerbose: false,
      customModels: [],
      ...overrides,
    });
    (window as unknown as { nexus: unknown }).nexus = {
      adapters: { list: vi.fn(async () => adapters) },
      orch: { saveSquad: vi.fn(async () => ({ ok: true as const })) },
    };
    act(() => {
      useProviderStore.getState().receive([
        provider('claude'),
        provider('codex', {
          authStrategy: 'login-needed',
          authReadyModels: [],
          loginCommand: 'codex login',
        }),
      ]);
    });

    try {
      const squad: Squad = {
        ...builtin,
        agents: [
          {
            id: 'w',
            agentName: 'Writer',
            category: 'executor',
            cli: 'codex',
            model: 'gpt-x',
            allowedTools: null,
          },
        ],
      };
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          <SquadEditor squad={squad} onClose={vi.fn()} onSaved={vi.fn()} />,
        );
      });
      await act(async () => {});

      const modelSelect = document.body.querySelector<HTMLSelectElement>(
        'select[aria-label="Modelo"]',
      )!;
      const gpt = [...modelSelect.options].find(
        (option) => option.value === 'gpt-x',
      )!;
      expect(gpt.disabled).toBe(true);
      expect(gpt.text).toContain('login necessário');

      const cliSelect = document.body.querySelector<HTMLSelectElement>(
        'select[aria-label="CLI"]',
      )!;
      await act(async () => {
        cliSelect.value = 'claude';
        cliSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Trocou para CLI com sessão: cai no primeiro modelo usável (sonnet),
      // não no primeiro da lista cega.
      expect(
        document.body.querySelector<HTMLSelectElement>(
          'select[aria-label="Modelo"]',
        )!.value,
      ).toBe('sonnet');
      act(() => root.unmount());
    } finally {
      act(() => {
        useProviderStore.getState().receive([]);
      });
    }
  });
});
