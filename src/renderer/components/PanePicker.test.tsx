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
import {
  PanePicker,
  buildPanePickerEntries,
  runPanePickerIntent,
  withAccountActions,
} from './PanePicker';

/**
 * O painel de contas real monta o hub inteiro (IPC, uso, confirmação). Aqui
 * interessa o CONTRATO do menu com ele: recebe a CLI certa e devolve o id da
 * conta nova. O painel tem a própria suíte co-locada.
 */
const accountsManager = vi.hoisted(() => ({
  added: null as null | ((accountId: string) => void),
  adapterId: '',
}));
vi.mock('./settings/AccountsManager', () => ({
  AccountsManager: (props: {
    adapterId: string;
    onAccountAdded?: (accountId: string) => void;
  }) => {
    accountsManager.adapterId = props.adapterId;
    accountsManager.added = props.onAccountAdded ?? null;
    return <div data-testid="accounts-manager">{props.adapterId}</div>;
  },
}));

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
    accountsManager.added = null;
    accountsManager.adapterId = '';
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    usePanePickerStore.setState({
      pendingOpen: false,
      pendingAccountsAdapterId: null,
    });
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
    expect(groupHeadings()).toEqual(['Claude', 'Codex', 'Bare CLI']);
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

    // 2 contas × 2 modelos, mais a linha de cadastro que fecha o grupo.
    expect(options()).toHaveLength(5);
    expect(optionLabels()[0]).toContain('Conta 1');
    expect(optionLabels()[0]).toContain('claude-default');
    expect(optionLabels()[4]).toContain('Adicionar conta');

    clickEntry('agent:claude:acc-2:claude-alt');

    expect(spawnAgent).toHaveBeenCalledWith('claude', 'claude-alt', {
      accountId: 'acc-2',
    });
  });

  it('conta com sessão expirada aparece nomeada, nunca com nome limpo', () => {
    useAccountStore.setState({
      accounts: [
        account('acc-1', 'claude', 'Conta 1', { needsRelogin: true }),
      ],
    } as never);
    mount();
    openMenu();
    type('claude');

    expect(
      optionLabels().some((label) => label.includes('Conta 1 (sessão expirada)')),
    ).toBe(true);
    expect(
      optionLabels().some(
        (label) => label.includes('Conta 1') && !label.includes('expirada'),
      ),
    ).toBe(false);
  });

  it('CLI sem catálogo de modelos ainda oferece uma linha que abre', () => {
    mount();
    openMenu();
    type('bare');

    expect(options()).toHaveLength(2);
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

  it('cada CLI ganha a ação de cadastrar conta, sempre no fim do grupo', () => {
    useAccountStore.setState({
      accounts: [account('acc-1', 'claude', 'Conta 1')],
    } as never);
    mount();
    openMenu();

    // Uma ação por CLI instalada — nem a mais, nem a menos.
    const admin = options().filter(
      (option) => option.getAttribute('data-admin') === 'true',
    );
    expect(admin).toHaveLength(3); // Bare CLI, Claude, Codex
    expect(admin[0]!.textContent).toContain('Adicionar conta');
    expect(admin[0]!.textContent).toContain('1 conta salva');
    expect(admin[0]!.getAttribute('aria-label')).toBe(
      'Adicionar conta em Claude',
    );

    // Fecha o grupo: as escolhas de conta × modelo vêm todas antes dela.
    type('claude');
    const labels = optionLabels();
    expect(labels[labels.length - 1]).toContain('Adicionar conta');
  });

  it('a ação de cadastro NÃO entra no catálogo compartilhado com a grade', () => {
    const shared = buildPanePickerEntries(
      [provider('codex', 'Codex')],
      [account('acc-1', 'codex', 'Conta 1')],
    );
    expect(shared.some((entry) => entry.id.startsWith('accounts:'))).toBe(false);
    // Só a decoração local do menu a acrescenta.
    const rows = withAccountActions(shared, [account('acc-1', 'codex', 'Conta 1')]);
    expect(rows.filter((row) => row.id === 'accounts:codex')).toHaveLength(1);
  });

  it('a busca alcança o cadastro pelo nome da ferramenta e por "conta"', () => {
    mount();
    openMenu();

    type('adicionar conta codex');
    expect(options()).toHaveLength(1);
    expect(optionLabels()[0]).toContain('Adicionar conta');
    expect(groupHeadings()).toEqual(['Codex']);
  });

  it('cadastrar abre a vista de contas daquela CLI, sem criar pane nenhum', () => {
    mount();
    openMenu();
    clickEntry('accounts:codex');

    expect(host.querySelector('[data-testid="accounts-manager"]')).not.toBeNull();
    expect(accountsManager.adapterId).toBe('codex');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(addShellPane).not.toHaveBeenCalled();
    expect(
      host.querySelector('.pane-picker__panel')?.getAttribute('data-view'),
    ).toBe('accounts');
  });

  it('a vista de contas não sequestra as teclas da lista', () => {
    mount();
    openMenu();
    clickEntry('accounts:codex');

    const panel = host.querySelector('.pane-picker__panel')!;
    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });

    // Enter dentro do formulário pertence ao formulário: nada foi aberto.
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="accounts-manager"]')).not.toBeNull();
  });

  it('Escape sobe um nível: de contas para a lista, e só então fecha', () => {
    mount();
    openMenu();
    clickEntry('accounts:codex');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(host.querySelector('[data-testid="accounts-manager"]')).toBeNull();
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Voltar às contas devolve a lista e o foco à busca', () => {
    mount();
    openMenu();
    clickEntry('accounts:codex');

    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="pane-picker-accounts-back"]',
    );
    act(() => back!.click());

    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(document.activeElement).toBe(filterInput());
  });

  it('conta nova volta para a lista sob o cursor, e o spawn leva o id dela', () => {
    mount();
    openMenu();
    clickEntry('accounts:codex');

    // O painel salvou a conta B e devolveu o id que o motor emitiu.
    act(() => {
      useAccountStore.setState({
        accounts: [
          account('acc-a', 'codex', 'trabalho'),
          account('acc-b', 'codex', 'pessoal', { active: false }),
        ],
      } as never);
      accountsManager.added!('acc-b');
    });

    // Voltou para a lista SEM abrir pane: a escolha do modelo é explícita.
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(spawnAgent).not.toHaveBeenCalled();

    const fresh = options().filter(
      (option) => option.getAttribute('data-fresh') === 'true',
    );
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0]!.textContent).toContain('pessoal');
    expect(fresh[0]!.getAttribute('aria-selected')).toBe('true');

    clickEntry('agent:codex:acc-b:codex-alt');
    expect(spawnAgent).toHaveBeenCalledWith('codex', 'codex-alt', {
      accountId: 'acc-b',
    });
  });

  const CLAUDE_CATALOG: Partial<ProviderSettingsInfo> = {
    defaultModel: 'claude-sonnet-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    modelInfo: {
      'claude-opus-5': { id: 'claude-opus-5', costTier: 'high', availability: 'paid' },
      'claude-sonnet-5': { id: 'claude-sonnet-5', costTier: 'medium', availability: 'paid' },
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', costTier: 'low', availability: 'cheap' },
    },
  };

  const optionIds = () =>
    options().map((option) => option.dataset.testid?.replace('pane-picker-entry-', ''));

  it('conta por fora, modelo por dentro: cada conta encabeça o próprio bloco com o estado dela', () => {
    useProviderStore.setState({
      providers: [provider('claude', 'Claude', CLAUDE_CATALOG)],
    } as never);
    useAccountStore.setState({
      accounts: [
        account('acc-a', 'claude', 'Conta A', { email: 'a@x.dev' }),
        account('acc-b', 'claude', 'Conta B', { active: false, needsRelogin: true }),
      ],
    } as never);
    mount();
    openMenu();
    type('claude');

    // Bloco inteiro da conta A, depois o da conta B — nunca intercalado.
    expect(optionIds()).toEqual([
      'agent:claude:acc-a:claude-opus-5',
      'agent:claude:acc-a:claude-sonnet-5',
      'agent:claude:acc-a:claude-haiku-4-5',
      'agent:claude:acc-b:claude-opus-5',
      'agent:claude:acc-b:claude-sonnet-5',
      'agent:claude:acc-b:claude-haiku-4-5',
      'accounts:claude',
    ]);
    const headings = [...host.querySelectorAll('.pane-picker__account')];
    expect(headings.map((node) => node.textContent)).toEqual([
      'Conta Aa@x.devativa',
      'Conta Bsessão expirada',
    ]);
    expect(headings[0]!.getAttribute('data-status')).toBe('active');
    expect(headings[1]!.getAttribute('data-status')).toBe('expired');
    // O modelo é a linha; a conta segue no texto acessível da opção.
    expect(optionLabels()[0]).toContain('claude-opus-5');
    expect(optionLabels()[0]).toContain('Conta A');
    expect(optionLabels()[3]).toContain('Conta B (sessão expirada)');
    expect(groupHeadings()).toEqual(['Claude']);
  });

  it('o mais forte e mais novo vem primeiro, com a faixa e o padrão em chips', () => {
    useProviderStore.setState({
      providers: [provider('claude', 'Claude', CLAUDE_CATALOG)],
    } as never);
    mount();
    openMenu();
    type('claude');

    const badgesOf = (entryId: string) =>
      [
        ...host.querySelectorAll(
          `[data-testid="pane-picker-entry-${entryId}"] .pane-picker__badge`,
        ),
      ].map((node) => node.textContent);
    // O default (sonnet) deixa de ser o primeiro à força: o opus é mais forte.
    expect(optionIds()[0]).toBe('agent:claude:default:claude-opus-5');
    expect(badgesOf('agent:claude:default:claude-opus-5')).toEqual(['Profundo']);
    expect(badgesOf('agent:claude:default:claude-sonnet-5')).toEqual([
      'Equilibrado',
      'padrão',
    ]);
    expect(badgesOf('agent:claude:default:claude-haiku-4-5')).toEqual(['Rápido']);
    // Sem conta salva, o bloco diz de onde vem a credencial.
    expect(host.querySelector('.pane-picker__account')?.textContent).toBe(
      'padrãocredencial ativa da CLI',
    );

    // Os chips também são busca: "rapido" acha o haiku.
    type('rapido');
    expect(optionIds()).toEqual(['agent:claude:default:claude-haiku-4-5']);
  });

  it('ordena CLIs pela preferência operacional e contas ativas antes das indisponíveis', () => {
    useProviderStore.setState({
      providers: [
        provider('aider', 'Aider'),
        provider('codex', 'Codex'),
        provider('claude', 'Claude'),
      ],
    } as never);
    useAccountStore.setState({
      accounts: [
        account('claude-cooling', 'claude', 'Conta ativa em pausa', {
          active: true,
          onCooldown: true,
        }),
        account('claude-expired', 'claude', 'Conta antiga', {
          active: false,
          needsRelogin: true,
        }),
        account('claude-ready', 'claude', 'Conta pronta', { active: false }),
      ],
    } as never);

    mount();
    openMenu();

    expect(groupHeadings()).toEqual(['Claude', 'Codex', 'Aider']);
    const headings = [...host.querySelectorAll('.pane-picker__account')].map(
      (node) => node.textContent,
    );
    expect(headings.slice(0, 3)).toEqual([
      'Conta pronta',
      'Conta ativa em pausaem pausa (limite)',
      'Conta antigasessão expirada',
    ]);
  });

  it('dobra cada conta nos 4 mais fortes; "mais N modelos" abre o resto e a busca vê tudo', () => {
    useProviderStore.setState({
      providers: [
        provider('codex', 'Codex', {
          defaultModel: 'gpt-5.6-terra',
          models: [
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex',
          ],
        }),
      ],
    } as never);
    mount();
    openMenu();

    expect(optionIds()).toEqual([
      'type:terminal',
      'type:browser',
      'agent:codex:default:gpt-5.6-sol',
      'agent:codex:default:gpt-5.6-terra',
      'agent:codex:default:gpt-5.6-luna',
      'agent:codex:default:gpt-5.5',
      'more:codex:default',
      'accounts:codex',
    ]);
    expect(optionLabels()[6]).toContain('mais 3 modelos');

    // A busca nunca respeita a dobra; apagar o texto dobra de novo.
    type('mini');
    expect(optionIds()).toEqual(['agent:codex:default:gpt-5.4-mini']);
    type('');
    expect(optionIds()).toContain('more:codex:default');

    // Abrir a dobra não fecha o menu nem abre pane nenhum.
    clickEntry('more:codex:default');
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(optionIds()).toEqual([
      'type:terminal',
      'type:browser',
      'agent:codex:default:gpt-5.6-sol',
      'agent:codex:default:gpt-5.6-terra',
      'agent:codex:default:gpt-5.6-luna',
      'agent:codex:default:gpt-5.5',
      'agent:codex:default:gpt-5.4',
      'agent:codex:default:gpt-5.3-codex',
      'agent:codex:default:gpt-5.4-mini',
      'accounts:codex',
    ]);

    // Reabrir começa dobrado: a dobra é estado do menu, não preferência.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    openMenu();
    expect(optionIds()).toContain('more:codex:default');
  });

  it('a dobra só existe quando esconderia pelo menos 2 modelos', () => {
    useProviderStore.setState({
      providers: [
        provider('codex', 'Codex', {
          defaultModel: 'gpt-5.6-terra',
          models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
        }),
      ],
    } as never);
    mount();
    openMenu();
    type('codex');

    expect(optionIds()).toEqual([
      'agent:codex:default:gpt-5.6-sol',
      'agent:codex:default:gpt-5.6-terra',
      'agent:codex:default:gpt-5.6-luna',
      'agent:codex:default:gpt-5.5',
      'agent:codex:default:gpt-5.4',
      'accounts:codex',
    ]);
  });

  it('N contas da mesma CLI viram N escolhas × modelo, sem teto', () => {
    useAccountStore.setState({
      accounts: [
        account('acc-a', 'codex', 'A'),
        account('acc-b', 'codex', 'B', { active: false }),
        account('acc-c', 'codex', 'C', { active: false }),
        account('acc-d', 'codex', 'D', { active: false }),
      ],
    } as never);
    mount();
    openMenu();
    type('codex');

    // 4 contas × 2 modelos + a linha de cadastro.
    expect(options()).toHaveLength(9);
    clickEntry('agent:codex:acc-c:codex-default');
    expect(spawnAgent).toHaveBeenCalledWith('codex', 'codex-default', {
      accountId: 'acc-c',
    });
  });

  it('conta sem e-mail é escolhível pelo rótulo, como qualquer outra', () => {
    useAccountStore.setState({
      accounts: [
        account('acc-sem-email', 'codex', 'workspace 2', { email: undefined }),
      ],
    } as never);
    mount();
    openMenu();
    type('workspace 2');

    expect(options()).toHaveLength(2);
    clickEntry('agent:codex:acc-sem-email:codex-alt');
    expect(spawnAgent).toHaveBeenCalledWith('codex', 'codex-alt', {
      accountId: 'acc-sem-email',
    });
  });

  it('o pedido pendente devolve a vista de contas depois de o login navegar', () => {
    mount();
    act(() => usePanePickerStore.getState().requestOpen('codex'));

    expect(host.querySelector('[data-testid="accounts-manager"]')).not.toBeNull();
    expect(accountsManager.adapterId).toBe('codex');
    expect(usePanePickerStore.getState().pendingAccountsAdapterId).toBeNull();
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
