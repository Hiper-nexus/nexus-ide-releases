/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import { TerminalGridDialog } from './TerminalGridDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { useConfirmStore } from '../state/confirm-store';
import { useTerminalGridDialogStore } from '../state/terminal-grid-dialog-store';
import { useLayoutStore } from '../state/layout-store';
import { usePaneScopeStore } from '../state/pane-scope-store';
import { spaceScopeKey } from '../lib/pane-spaces';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useProviderStore } from '../state/provider-store';
import { useAccountStore } from '../state/account-store';
import { createPane, initialTree, listPanes, buildGridTree } from '../lib/split-tree';
import { MAX_LIVE_PANES_HARD } from '../../shared/pane-limits';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const project = { path: '/projects/nexus', name: 'nexus', lastOpenedAt: 1 };
let host: HTMLDivElement;
let root: Root;

function provider(adapterId: string, installed = true): ProviderSettingsInfo {
  return {
    adapterId, label: adapterId, icon: '', kind: 'cli-pty', enabled: true,
    installed, canAutoInstall: false, binPath: '', detectedBin: adapterId,
    defaultModel: `${adapterId}-default`, models: [`${adapterId}-default`, `${adapterId}-alt`],
    customModels: [], extraArgs: [], keyEnvVar: null, hasKey: false, keyMasked: null,
    authMethod: 'cli', secureStorageAvailable: true, authStrategy: 'subscription',
    upstream: '', routable: false, upstreams: [], permissionMode: '', permissionModes: [],
    effort: '', efforts: [], verbose: false, supportsVerbose: false,
  };
}

function button(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll('button')].find(
    b => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label,
  );
  expect(el, `button: ${label}`).toBeTruthy();
  return el!;
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click());
}

function select(label: string, value: string): void {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(el, label).toBeTruthy();
  act(() => {
    el!.value = value;
    el!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function open(count = 2): void {
  act(() => useTerminalGridDialogStore.getState().open({ initialCount: count }));
}

function panes() { return listPanes(useLayoutStore.getState().root); }

beforeEach(() => {
  useTerminalGridDialogStore.getState().close();
  useConfirmStore.setState({ pending: null, queue: [] });
  useWorkspaceStore.setState({ current: project, recents: [project] });
  useLayoutStore.setState({ root: initialTree(), maximizedPaneId: null });
  useProductNavigationStore.getState().openLauncher();
  usePaneScopeStore.getState().clearScopeFocus();
  useProviderStore.setState({ providers: [provider('codex'), provider('claude'), provider('missing', false)] });
  useAccountStore.setState({ accounts: [{
    id: 'codex-work', adapterId: 'codex', label: 'Trabalho', mode: 'subscription',
    upstream: '', createdAt: 1, active: true, hasCredential: true,
    onCooldown: false, needsRelogin: false,
  }] });
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    workspace: { pickPath: vi.fn().mockResolvedValue('/projects/other') },
  } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<><TerminalGridDialog /><ConfirmDialog /></>));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('TerminalGridDialog', () => {
  it('fica fechado até o operador escolher configurar terminais', () => {
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('explica as duas etapas e a opção sem IA antes de abrir qualquer painel', () => {
    open(2);
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('Pasta e painéis');
    expect(host.textContent).toContain('Etapa 1 de 2');
    expect(host.textContent).toContain('Um painel é uma área independente');
    expect(host.textContent).toContain('Sem IA');
    expect(host.querySelector('[aria-label="Resumo da abertura"]')?.textContent).toContain(project.path);
    expect(panes()[0].isStructuralPlaceholder).toBe(true);
  });

  it('resume a mistura de IA e terminais comuns antes da abertura', async () => {
    open(3);
    await click('Próximo: escolher IAs');
    select('Ferramenta do painel 1', 'codex');
    const summary = host.querySelector('[aria-label="Resumo da abertura"]');
    expect(host.textContent).toContain('Etapa 2 de 2');
    expect(summary?.textContent).toContain('3 painéis');
    expect(summary?.textContent).toContain('1 com IA');
    expect(summary?.textContent).toContain('2 sem IA');
    expect(summary?.textContent).toContain(project.path);
    expect(host.textContent).toContain('aplicativos de terminal (CLIs)');
    expect(panes()[0].isStructuralPlaceholder).toBe(true);
  });

  it('distingue a escolha da pasta da abertura dos terminais no estado de espera', async () => {
    let finishPicking!: (value: string | null) => void;
    vi.mocked(window.nexus.workspace.pickPath).mockImplementationOnce(() => new Promise(resolve => { finishPicking = resolve; }));
    open();
    await click('Escolher pasta');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Escolhendo a pasta');
    expect(host.querySelector('.terminal-setup__primary')?.textContent).toContain('Escolhendo pasta');
    expect(button('Cancelar').disabled).toBe(true);
    await act(async () => { finishPicking(null); });
    expect(button('Cancelar').disabled).toBe(false);
    expect(panes()[0].isStructuralPlaceholder).toBe(true);
  });

  it('oferece layouts visuais e abre doze shells na pasta escolhida', async () => {
    open();
    await click('12 terminais');
    await click('Abrir sem IA');
    expect(panes()).toHaveLength(12);
    expect(panes().every(p => p.kind === 'shell' && p.cwd === project.path)).toBe(true);
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'terminal' });
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(false);
  });

  it('leva modelo e conta independentes para cada painel e permite misturar shell', async () => {
    open(3);
    await click('Próximo: escolher IAs');
    select('Ferramenta do painel 1', 'codex');
    select('Modelo e conta do painel 1', 'agent:codex:codex-work:codex-alt');
    select('Ferramenta do painel 2', 'claude');
    select('Modelo e conta do painel 2', 'agent:claude:default:claude-default');
    await click('Abrir 3 terminais');
    expect(panes()).toEqual([
      expect.objectContaining({ kind: 'cli-agent', cwd: project.path, adapterId: 'codex', model: 'codex-alt', accountId: 'codex-work' }),
      expect.objectContaining({ kind: 'cli-agent', cwd: project.path, adapterId: 'claude', model: 'claude-default' }),
      expect.objectContaining({ kind: 'shell', cwd: project.path }),
    ]);
    expect(panes()[2].accountId).toBeUndefined();
  });

  it('preserva escolhas ao voltar, mudar a quantidade e avançar', async () => {
    open(2);
    await click('Próximo: escolher IAs');
    select('Ferramenta do painel 1', 'codex');
    await click('Voltar ao layout');
    await click('4 terminais');
    await click('Próximo: escolher IAs');
    await click('Aplicar painel 1 a todos');
    await click('Abrir 4 terminais');
    expect(panes()).toHaveLength(4);
    expect(panes().every(p => p.adapterId === 'codex' && p.accountId === 'codex-work')).toBe(true);
  });

  it('acrescenta os novos painéis sem apagar sessões e missões existentes', async () => {
    const running = { ...createPane('cli-agent', project.path, 'claude'), missionId: 'live-mission' };
    useLayoutStore.setState({ root: buildGridTree([running]) });
    open(2);
    await click('Abrir sem IA');
    expect(panes()).toHaveLength(3);
    expect(panes()[0]).toEqual(running);
  });

  // F-560: era exatamente aqui que o bug nascia — os painéis entravam na árvore
  // sem dono e a vista global os desenhava no mesmo mosaico da missão aberta.
  it('os painéis novos nascem num ESPAÇO separado da missão em andamento', async () => {
    const running = { ...createPane('cli-agent', project.path, 'claude'), missionId: 'live-mission' };
    useLayoutStore.setState({ root: buildGridTree([running]) });
    open(2);
    await click('Abrir sem IA');

    const created = panes().filter(pane => pane.id !== running.id);
    expect(created).toHaveLength(2);
    // Um espaço só para os dois, e nenhum deles herda a missão que já rodava.
    const spaceIds = new Set(created.map(pane => pane.spaceId));
    expect(spaceIds.size).toBe(1);
    expect([...spaceIds][0]).toBeTruthy();
    expect(created.every(pane => pane.missionId === undefined)).toBe(true);
    expect(created.every(pane => pane.spaceTitle === 'Meus terminais')).toBe(true);
    // O pane da missão fica intocado: nada de recarimbar o que já tem dono.
    expect(panes().find(pane => pane.id === running.id)).toEqual(running);
  });

  it('a vista de Terminais abre JÁ dentro do espaço recém-criado', async () => {
    open(2);
    await click('Abrir sem IA');

    const spaceId = panes().find(pane => pane.spaceId)?.spaceId;
    expect(spaceId).toBeTruthy();
    expect(usePaneScopeStore.getState().activeScopeKey).toBe(spaceScopeKey(spaceId!));
  });

  it('cada abertura ganha o PRÓXIMO nome livre, sem dois "Meus terminais"', async () => {
    open(2);
    await click('Abrir sem IA');
    const first = panes().find(pane => pane.spaceId)!.spaceId;
    open(2);
    await click('Abrir sem IA');

    const titles = new Map<string, string>();
    for (const pane of panes()) {
      if (pane.spaceId && pane.spaceTitle) titles.set(pane.spaceId, pane.spaceTitle);
    }
    expect(titles.size).toBe(2);
    expect(titles.get(first!)).toBe('Meus terminais');
    expect([...titles.values()].sort()).toEqual(['Meus terminais', 'Meus terminais 2']);
  });

  it('escolher pasta não troca o workspace até confirmar a abertura', async () => {
    const openWorkspace = vi.spyOn(useWorkspaceStore.getState(), 'open').mockImplementation(async path => {
      useWorkspaceStore.setState({ current: { ...project, path } });
      useLayoutStore.setState({ root: initialTree() });
    });
    open();
    await click('Escolher pasta');
    expect(openWorkspace).not.toHaveBeenCalled();
    await click('Abrir sem IA');
    expect(openWorkspace).toHaveBeenCalledWith('/projects/other');
    expect(panes().every(p => p.cwd === '/projects/other')).toBe(true);
  });

  it('informa falha ao abrir pasta e mantém o diálogo e o layout', async () => {
    vi.spyOn(useWorkspaceStore.getState(), 'open').mockRejectedValue(new Error('Pasta não encontrada'));
    open();
    await click('Escolher pasta');
    const before = panes();
    await click('Abrir sem IA');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Pasta não encontrada');
    expect(panes()).toEqual(before);
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(true);
  });

  it('pede confirmação antes de encerrar sessões de outro projeto e permite cancelar por Escape', async () => {
    const running = createPane('shell', project.path);
    useLayoutStore.setState({ root: buildGridTree([running]) });
    const openWorkspace = vi.spyOn(useWorkspaceStore.getState(), 'open');
    open();
    await click('Escolher pasta');
    await click('Abrir sem IA');
    expect(useConfirmStore.getState().pending?.body).toContain('processos em execução serão encerrados');
    expect(openWorkspace).not.toHaveBeenCalled();
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(true);
    expect(panes()).toEqual([running]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it('usa a pasta canônica retornada pelo workspace ao criar os terminais', async () => {
    vi.spyOn(useWorkspaceStore.getState(), 'open').mockImplementation(async () => {
      useWorkspaceStore.setState({ current: { ...project, path: '/canonical/other' } });
      useLayoutStore.setState({ root: initialTree() });
    });
    open();
    await click('Escolher pasta');
    await click('Abrir sem IA');
    expect(panes().every(pane => pane.cwd === '/canonical/other')).toBe(true);
  });

  it('impede lançamento parcial quando a soma ultrapassa o limite de painéis', async () => {
    useLayoutStore.setState({ root: buildGridTree(Array.from({length: MAX_LIVE_PANES_HARD - 1}, () => createPane())) });
    open(2);
    await click('Abrir sem IA');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('limite');
    expect(panes()).toHaveLength(MAX_LIVE_PANES_HARD - 1);
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(true);
  });

  it('não oferece CLI não instalada e bloqueia uma seleção que ficou indisponível', async () => {
    open();
    await click('Próximo: escolher IAs');
    expect(host.querySelector('option[value="missing"]')).toBeNull();
    select('Ferramenta do painel 1', 'codex');
    act(() => useProviderStore.setState({ providers: [provider('claude')] }));
    await click('Abrir 2 terminais');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('indisponível');
    expect(panes()[0].isStructuralPlaceholder).toBe(true);
  });

  it('mantém Tab no diálogo e Enter em Cancelar não abre terminais', () => {
    open();
    const cancel = button('Cancelar');
    const before = panes();
    act(() => {
      cancel.focus();
      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(panes()).toEqual(before);
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(false);
    open();
    const controls = [...host.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
    act(() => {
      controls.at(-1)!.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(controls[0]);
  });
});
