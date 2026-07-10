/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { useAccountStore } from '../../state/account-store';
import { useProviderStore } from '../../state/provider-store';
import { ProvidersPanel } from './ProvidersPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function provider(adapterId: string, label: string): ProviderSettingsInfo {
  return {
    adapterId,
    label,
    icon: '◆',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    binPath: '',
    detectedBin: adapterId,
    defaultModel: `${adapterId}-default`,
    models: [`${adapterId}-default`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'cli',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: 'anthropic',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
  };
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<ProvidersPanel />));
  return { host, root };
}

describe('ProvidersPanel disclosure', () => {
  beforeEach(() => {
    useProviderStore.setState({
      providers: [provider('claude', 'Claude'), provider('codex', 'Codex')],
    });
    useAccountStore.setState({ accounts: [] });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: { authStatus: vi.fn(async () => []) },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps the provider catalog compact until one provider is expanded', async () => {
    const { host, root } = mount();
    const disclosures = [...host.querySelectorAll<HTMLButtonElement>('.prov__disclosure')];

    expect(disclosures).toHaveLength(2);
    expect(disclosures[0].getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Binário (vazio');

    await act(async () => disclosures[0].click());

    expect(disclosures[0].getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Binário (vazio');
    act(() => root.unmount());
  });
});
