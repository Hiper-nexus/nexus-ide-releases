/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from './Onboarding';
import { useOnboardingStore } from '../state/onboarding-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const initialOnboarding = useOnboardingStore.getState();

const PROVIDER_CANDIDATE = {
  adapterId: 'claude',
  label: 'Claude',
  icon: 'C',
  kind: 'cli-pty' as const,
  enabled: true,
  installed: false,
  canAutoInstall: true,
  binPath: '',
  detectedBin: '',
  defaultModel: 'default',
  models: [],
  extraArgs: [],
  keyEnvVar: null,
  hasKey: false,
  keyMasked: null,
  authMethod: 'oauth',
};

function setNexusApi(opts: { installOk?: boolean; installError?: string } = {}) {
  const installCli = vi.fn(async () =>
    opts.installOk === false
      ? { ok: false, error: opts.installError ?? 'falhou' }
      : { ok: true },
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: {
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => () => {}),
      },
      providers: {
        list: vi.fn(async () => [PROVIDER_CANDIDATE]),
        installCli,
      },
      onboarding: {
        set: vi.fn(async (patch: Record<string, unknown>) => ({
          completed: false,
          skipped: false,
          victories: {},
          ...patch,
        })),
      },
    },
  });
  return { installCli };
}

function mountOnboarding(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Onboarding />));
  return { host, root };
}

function ctaOf(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('.onb__cta')];
}

describe('Onboarding — CTA nunca disabled (critique P2)', () => {
  beforeEach(() => {
    useOnboardingStore.setState({
      loaded: true,
      state: { completed: false, skipped: false, victories: {} },
    });
  });

  afterEach(() => {
    useOnboardingStore.setState(initialOnboarding);
    document.body.innerHTML = '';
  });

  it('sem CLI: oferece instalar a CLI auto-instalável e, no sucesso, vira Começar a operar', async () => {
    const { installCli } = setNexusApi();
    const { host, root } = mountOnboarding();
    await act(async () => {});

    // Sem CLI instalada o primário NÃO pode estar disabled — oferece ação.
    const cta = ctaOf(host)[0];
    expect(cta).toBeTruthy();
    expect(cta.disabled).toBe(false);
    expect(cta.textContent).toContain('Instalar Claude');

    await act(async () => {
      cta.click();
    });
    expect(installCli).toHaveBeenCalledWith('claude');

    // Sucesso otimista (cache de adapters do main demora): vira Começar.
    const next = ctaOf(host)[0];
    expect(next.textContent).toContain('Começar a operar');
    expect(host.textContent).toContain('instalada — o login acontece no primeiro uso');
    act(() => root.unmount());
  });

  it('falha da instalação mostra erro inline e mantém o CTA de instalação', async () => {
    setNexusApi({ installOk: false, installError: 'brew ausente' });
    const { host, root } = mountOnboarding();
    await act(async () => {});

    const cta = ctaOf(host)[0];
    await act(async () => {
      cta.click();
    });

    expect(host.textContent).toContain('brew ausente');
    expect(ctaOf(host)[0].textContent).toContain('Instalar Claude');
    expect(ctaOf(host)[0].disabled).toBe(false);
    act(() => root.unmount());
  });
});
