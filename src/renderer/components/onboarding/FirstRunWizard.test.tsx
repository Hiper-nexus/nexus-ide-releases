/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstRunWizard, type FirstRunWizardHandlers } from './FirstRunWizard';
import { useOnboardingStore } from '../../state/onboarding-store';
import { useProviderStore } from '../../state/provider-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}

function setup() {
  const handlers: FirstRunWizardHandlers = {
    onOpenApiKeys: vi.fn(),
    onOpenProviders: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onStartMission: vi.fn(),
    onOpenPane: vi.fn(),
    onOpenShellTerminal: vi.fn(),
  };
  const host = render(<FirstRunWizard {...handlers} />);
  return { host, handlers };
}

describe('FirstRunWizard', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOnboardingStore.getState().reset();
    useOnboardingStore.setState({ wizardOpen: true, stepIndex: 0 });
    useProviderStore.setState({ providers: [] });
  });

  it('opens account connection first and keeps API keys available', () => {
    const { host, handlers } = setup();
    expect(host.textContent).toContain('Conecte sua IA');
    expect(host.textContent).toContain('Configurações → Chaves de API');
    expect(host.textContent).toContain('Configurações → Contas de IA');
    const primary = host.querySelector<HTMLButtonElement>('.onboarding-step__body .onboarding-btn--primary');
    expect(primary?.textContent).toBe('Conectar minha conta');
    act(() => primary!.click());
    expect(handlers.onOpenProviders).toHaveBeenCalledOnce();
    expect(handlers.onOpenApiKeys).not.toHaveBeenCalled();
    act(() => button(host, 'Abrir Chaves de API').click());
    expect(handlers.onOpenApiKeys).toHaveBeenCalledOnce();
  });

  it('walks keys → agents → project → use and finishes with Começar', () => {
    const { host, handlers } = setup();
    act(() => button(host, 'Continuar').click());
    expect(host.textContent).toContain('Suas ferramentas de IA');
    act(() => button(host, 'Continuar').click());
    expect(host.textContent).toContain('Seu primeiro projeto');
    act(() => button(host, 'Continuar').click());
    expect(host.textContent).toContain('Como usar o Nexus');
    expect(host.textContent).toContain('Space (segurar) = ditar');
    expect(host.textContent).toContain('+ Pane');
    expect(host.textContent).toContain('Formas de iniciar');
    act(() => button(host, 'Começar').click());
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(useOnboardingStore.getState().state.outcome).toBe('completed');
    expect(handlers.onOpenApiKeys).not.toHaveBeenCalled();
  });

  it('shows real agent readiness from the provider store', () => {
    useProviderStore.setState({
      providers: [
        {
          adapterId: 'codex',
          label: 'Codex',
          icon: 'terminal',
          kind: 'cli-pty',
          enabled: true,
          installed: true,
          canAutoInstall: false,
          binPath: 'codex',
          detectedBin: 'codex',
          defaultModel: '',
          models: [],
          extraArgs: [],
          keyEnvVar: null,
          hasKey: false,
          keyMasked: null,
          authMethod: 'oauth',
          authState: 'ok',
          secureStorageAvailable: true,
          authStrategy: 'subscription',
        },
        {
          adapterId: 'gemini',
          label: 'Gemini',
          icon: 'sparkle',
          kind: 'api-provider',
          enabled: true,
          installed: true,
          canAutoInstall: false,
          binPath: '',
          detectedBin: '',
          defaultModel: '',
          models: [],
          extraArgs: [],
          keyEnvVar: 'GEMINI_API_KEY',
          hasKey: false,
          keyMasked: null,
          authMethod: 'api-key',
          authState: 'missing',
          secureStorageAvailable: true,
          authStrategy: 'api-key',
        },
      ] as never,
    });
    const { host } = setup();
    act(() => button(host, 'Continuar').click());
    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('conectado');
    expect(host.textContent).toContain('precisa login');
  });

  it('does not call an invalid stored key ready or connected', () => {
    useProviderStore.setState({ providers: [{
      adapterId: 'gemini', label: 'Gemini', kind: 'api-provider', enabled: true,
      installed: true, hasKey: true, authState: 'ok', authStrategy: 'api-key',
      credentialReadiness: 'invalid-credential',
    }] as never });
    const { host } = setup();
    act(() => button(host, 'Continuar').click());
    expect(host.textContent).toContain('chave inválida');
    expect(host.textContent).not.toContain('Pronto');
    expect(host.textContent).not.toContain('conectado');
    expect(host.querySelector('.onboarding-badge--ok')).toBeNull();
  });

  it('explains when no agent is connected yet', () => {
    useProviderStore.setState({ providers: [] });
    const { host } = setup();
    act(() => button(host, 'Continuar').click());
    expect(host.textContent).toContain('Nenhuma ferramenta de IA conectada');
  });

  it('is always skippable via Pular', () => {
    const { host } = setup();
    act(() => button(host, 'Pular').click());
    expect(useOnboardingStore.getState().state.outcome).toBe('dismissed');
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
  });

  it('closes on Escape as dismiss', () => {
    setup();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(useOnboardingStore.getState().state.outcome).toBe('dismissed');
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
  });
});
