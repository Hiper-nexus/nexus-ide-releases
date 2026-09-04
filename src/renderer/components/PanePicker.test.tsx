/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../shared/account-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { FAILOVER_HANDOFF_HEADER } from '../../shared/failover-handoff';
import { createLeaf } from '../lib/split-tree';
import { useAccountStore } from '../state/account-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { usePanePickerStore } from '../state/pane-picker-store';
import { useProviderStore } from '../state/provider-store';
import { useSessionStateStore } from '../state/session-state-store';
import { PanePicker, runPanePickerIntent } from './PanePicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function provider(
  adapterId: string,
  label: string,
  opts: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
  return {
    adapterId,
    label,
    icon: '◆',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: adapterId,
    defaultModel: `${adapterId}-default`,
    models: [`${adapterId}-default`, `${adapterId}-alt`],
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
    ...opts,
  };
}

function account(
  id: string,
  adapterId: string,
  label: string,
  opts: Partial<AccountInfo> = {},
): AccountInfo {
  return {
    id,
    adapterId,
    label,
    mode: 'subscription',
    upstream: 'anthropic',
    createdAt: 1,
    active: true,
    hasCredential: true,
    onCooldown: false,
    needsRelogin: false,
    ...opts,
  };
}

const spawnAgent = vi.fn();
const addShellPane = vi.fn(() => 'pane-shell');
const addBrowserPane = vi.fn(() => 'pane-browser');

// jsdom não implementa scrollIntoView (mesmo stub do CommandPalette.test).
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

let host: HTMLDivElement;
let root: Root;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PanePicker />));
}

function trigger(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(
    '[data-testid="pane-picker-trigger"]',
  );
  if (!button) throw new Error('no "+ Pane" trigger rendered');
  return button;
}

function openMenu(): void {
  act(() => trigger().click());
}

function filterInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    '[data-testid="pane-picker-filter"]',
  );
  if (!input) throw new Error('no filter input rendered');
  return input;
}

function type(text: string): void {
  const input = filterInput();
  act(() => {
    // React 19 controlled input: value setter nativo + evento de input.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function options(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}

function optionLabels(): string[] {
  return options().map((option) => option.textContent ?? '');
}

function groupHeadings(): string[] {
  return [...host.querySelectorAll('.pane-picker__group-name')].map(
    (node) => node.textContent ?? '',
  );
}

function clickEntry(entryId: string): void {
  const button = host.querySelector<HTMLButtonElement>(
    `[data-testid="pane-picker-entry-${entryId}"]`,
  );
  if (!button) {
    throw new Error(
      `no entry "${entryId}" — entries: ${optionLabels().join(' | ')}`,
    );
  }
  act(() => button.click());
}

describe('PanePicker — abrir um pane já escolhendo o que ele é', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    useProviderStore.setState({
      providers: [
        provider('claude', 'Claude'),
        provider('codex', 'Codex'),
        // Sem catálogo declarado: legítimo, e ainda tem que abrir.
        provider('bare', 'Bare CLI', { defaultModel: '', models: [] }),
        // Não instalada e provider de API não são panes de CLI.
        provider('kimi', 'Kimi', { installed: false }),
        provider('glm', 'GLM', { kind: 'api-provider' }),
        // Desligada à mão em Configurações.
        provider('grok', 'Grok', { enabled: false }),
      ],
    } as never);
    useAccountStore.setState({ accounts: [] } as never);
    useOrchStore.setState({ missions: [], paneMissions: {} });
    useSessionStateStore.setState({ paneStates: new Map() });
    useLayoutStore.setState({
      spawnAgent,
      addShellPane,
      addBrowserPane,
    } as never);
    delete (
      window as Window & { __nexusGetScrollbackExcerpt?: unknown }
    ).__nexusGetScrollbackExcerpt;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    usePanePickerStore.setState({ pendingOpen: false });
    if (originalScrollIntoView) {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollIntoView',
        originalScrollIntoView,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    vi.clearAllMocks();
  });

  it('lista Terminal, Browser e cada CLI instalada — e só elas', () => {
    mount();
    openMenu();

    expect(optionLabels().some((label) => label.includes('Terminal'))).toBe(
      true,
    );
    expect(optionLabels().some((label) => label.includes('Browser'))).toBe(
      true,
    );
    expect(groupHeadings()).toEqual(['Bare CLI', 'Claude', 'Codex']);
    // Fora da lista principal, mas NOMEADAS na seção de indisponíveis.
    expect(optionLabels().some((label) => label.includes('Kimi'))).toBe(false);
    expect(optionLabels().some((label) => label.includes('Grok'))).toBe(false);
    expect(host.textContent).not.toContain('GLM');
  });

  it('nomeia as CLIs indisponíveis com o motivo — nunca filtra em silêncio', () => {
    mount();
    openMenu();

    const rows = [
      ...host.querySelectorAll('.pane-picker__unavailable-row'),
    ].map((node) => node.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Grok');
    expect(rows[0]).toContain('desligada em Configurações › Contas');
    expect(rows[1]).toContain('Kimi');
    expect(rows[1]).toContain('CLI não encontrada no PATH');
    // Indisponível não é clicável: não vira opção navegável.
    expect(options().some((o) => (o.textContent ?? '').includes('Grok'))).toBe(
      false,
    );
  });

  it('filtra por texto digitado em CLI, conta e modelo', () => {
    useAccountStore.setState({
      accounts: [account('acc-1', 'claude', 'Conta Pessoal')],
    } as never);
    mount();
    openMenu();

    type('codex');
    expect(groupHeadings()).toEqual(['Codex']);
    expect(optionLabels().some((label) => label.includes('Terminal'))).toBe(
      false,
    );

    type('pessoal');
    expect(groupHeadings()).toEqual(['Claude']);
    expect(options()).toHaveLength(2); // 2 modelos da conta pessoal

    type('claude-alt');
    expect(options()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('claude-alt');

    type('inexistente');
    expect(options()).toHaveLength(0);
    expect(host.textContent).toContain('Nada com esse nome');
  });

  it('abre o menu quando o Início pede um pane (pendingOpen)', () => {
    mount();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(() => usePanePickerStore.getState().requestOpen());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(usePanePickerStore.getState().pendingOpen).toBe(false);
  });

  it('clicar numa linha sobe o pane com adapterId e modelo exatos', () => {
    mount();
    openMenu();

    clickEntry('agent:codex:default:codex-alt');

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith('codex', 'codex-alt');
    // Escolher fecha o menu — o operador volta ao trabalho.
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('com contas salvas, cada linha é conta × modelo e fixa o accountId', () => {
    useAccountStore.setState({
      accounts: [
        account('acc-1', 'claude', 'Conta 1'),
        account('acc-2', 'claude', 'Conta 2', { active: false }),
      ],
    } as never);
    mount();
    openMenu();
    type('claude');

    // 2 contas × 2 modelos.
    expect(options()).toHaveLength(4);
    expect(optionLabels()[0]).toContain('Conta 1');
    expect(optionLabels()[0]).toContain('claude-default');

    clickEntry('agent:claude:acc-2:claude-alt');

    expect(spawnAgent).toHaveBeenCalledWith('claude', 'claude-alt', {
      accountId: 'acc-2',
    });
  });

  it('CLI sem catálogo de modelos ainda oferece uma linha que abre', () => {
    mount();
    openMenu();
    type('bare');

    expect(options()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('padrão da ferramenta');

    clickEntry('agent:bare:default:default');

    expect(spawnAgent).toHaveBeenCalledWith('bare', '');
  });

  it('Terminal e Browser usam as ações que já existem na store', () => {
    mount();
    openMenu();
    clickEntry('type:terminal');
    expect(addShellPane).toHaveBeenCalledTimes(1);

    openMenu();
    clickEntry('type:browser');
    expect(addBrowserPane).toHaveBeenCalledTimes(1);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('runPanePickerIntent devolve o id criado para vistas filtradas o exibirem', () => {
    expect(runPanePickerIntent({ kind: 'terminal' })).toBe('pane-shell');
    expect(runPanePickerIntent({ kind: 'browser' })).toBe('pane-browser');

    spawnAgent.mockReturnValueOnce('pane-agent');
    expect(
      runPanePickerIntent({ kind: 'agent', adapterId: 'codex', model: 'x' }),
    ).toBe('pane-agent');
  });

  it('setas movem a seleção e Enter abre a linha ativa', () => {
    mount();
    openMenu();
    type('codex');

    const panel = host.querySelector('.pane-picker__panel')!;
    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true');

    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(spawnAgent).toHaveBeenCalledWith('codex', 'codex-alt');
  });

  it('Escape fecha e devolve o foco ao gatilho', () => {
    mount();
    openMenu();
    expect(document.activeElement).toBe(filterInput());

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('clique fora fecha o menu', () => {
    mount();
    openMenu();

    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('+ Pane numa missão 401 entrega o handoff para a conta escolhida', () => {
    useOrchStore.setState({
      missions: [
        {
          id: 'm-radar',
          title: 'Radar BI',
          description: '',
          status: 'running',
          milestones: [],
          learnings: '',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      paneMissions: { 'pane-dead': 'm-radar' },
    });
    useSessionStateStore.setState({
      paneStates: new Map([['pane-dead', 'busy']]),
    });
    useAccountStore.setState({
      accounts: [
        account('acc-adm', 'claude', 'conta adm'),
        account('acc-good', 'claude', 'arrumou a baderna', { active: false }),
      ],
    } as never);
    useLayoutStore.setState({
      spawnAgent,
      addShellPane,
      addBrowserPane,
      focusedPaneId: 'pane-dead',
      root: createLeaf({
        id: 'pane-dead',
        kind: 'cli-agent',
        title: 'Claude',
        adapterId: 'claude',
        accountId: 'acc-adm',
        role: 'orchestrator',
        missionId: 'm-radar',
      }),
    } as never);
    (
      window as Window & {
        __nexusGetScrollbackExcerpt?: (id: string) => string;
      }
    ).__nexusGetScrollbackExcerpt = (paneId) =>
      paneId === 'pane-dead'
        ? 'API Error: 401 OAuth access token has expired. Please run /login'
        : '';

    runPanePickerIntent({
      kind: 'agent',
      adapterId: 'claude',
      model: 'claude-alt',
      accountId: 'acc-good',
    });

    expect(spawnAgent).toHaveBeenCalledWith(
      'claude',
      'claude-alt',
      expect.objectContaining({
        accountId: 'acc-good',
        continuityPack: expect.stringContaining(FAILOVER_HANDOFF_HEADER),
      }),
    );
    const pack = (spawnAgent.mock.calls[0]?.[2] as { continuityPack?: string })
      ?.continuityPack;
    expect(pack).toContain('m-radar');
    expect(pack).toContain('Radar BI');
  });
});
