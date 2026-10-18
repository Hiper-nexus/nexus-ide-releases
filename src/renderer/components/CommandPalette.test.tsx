/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const cliHistory = vi.hoisted(() => ({ importWithToast: vi.fn(async () => {}) }));
vi.mock('../lib/cli-history-import', () => ({
  importCliHistoryWithToast: cliHistory.importWithToast,
}));

const reopen = vi.hoisted(() => ({ confirm: vi.fn(async (_mission: unknown) => ({ ok: true })) }));
vi.mock('../orch/confirm-reopen-mission', () => ({
  confirmAndReopenMission: reopen.confirm,
}));

import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from '../state/command-palette-store';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';
import { useLayoutStore } from '../state/layout-store';
import { useMissionSetupStore } from '../state/mission-setup-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useBugReportDialogStore } from '../state/bug-report-dialog-store';
import { useSessionStateStore } from '../state/session-state-store';
import { setActiveWorkspacePath } from '../state/active-workspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

function actionButton(
  host: HTMLElement,
  label: string | RegExp,
): HTMLButtonElement {
  const action = Array.from(
    host.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
  ).find((button) => {
    const text = button.textContent?.trim() ?? '';
    return typeof label === 'string' ? text.includes(label) : label.test(text);
  });
  if (!action) throw new Error(`Palette action not found: ${String(label)}`);
  return action;
}

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });

  useLayoutStore.setState({
    focusedPaneId: 'pane-1',
    root: {
      kind: 'leaf',
      id: 'leaf-1',
      pane: { id: 'pane-1', kind: 'shell', title: 'Terminal' },
    },
  } as never);
  useSessionStateStore.setState({ paneStates: new Map() } as never);
  useOrchStore.setState({ missions: [], missionSummaries: [] });
  useContextualPanelNavStore.setState({ requestedTab: null, requestId: 0 });
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
  useCommandPaletteStore.setState({ open: true });
  useAttentionInboxStore.setState({ open: false });
  useBugReportDialogStore.setState({ isOpen: false });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScrollIntoView,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
  vi.restoreAllMocks();
});

describe('CommandPalette product navigation', () => {
  it.each([
    ['Nova missão', { kind: 'mission-setup' }],
    ['Missões e tarefas', { kind: 'task-board' }],
    ['Memória do projeto', { kind: 'memory' }],
    ['Configurações', { kind: 'settings' }],
  ] as const)(
    'routes %s through the canonical destination and closes the overlay',
    (label, expected) => {
      if (label === 'Nova missão') {
        useMissionSetupStore.setState({
          entryContext: { kind: 'pet-studio', revision: 1 },
        } as never);
      }
      const host = render(<CommandPalette />);
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();

      act(() => actionButton(host, label).click());

      expect(useProductNavigationStore.getState().destination).toEqual(expected);
      expect(useCommandPaletteStore.getState().open).toBe(false);
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      if (label === 'Nova missão') {
        expect(
          Reflect.get(useMissionSetupStore.getState(), 'entryContext'),
        ).toBeNull();
      }
    },
  );

  it('exposes one mission creation command and no retired product labels', () => {
    const host = render(<CommandPalette />);
    const labels = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
      (button) => button.textContent?.trim() ?? '',
    );

    expect(labels.filter((label) => label.includes('Nova missão'))).toHaveLength(
      1,
    );
    expect(labels.some((label) => label.includes('Missão rápida'))).toBe(false);
    expect(labels.some((label) => label.includes('Painel de operações'))).toBe(
      false,
    );
    expect(labels.some((label) => label.includes('Missões e tarefas'))).toBe(
      true,
    );
    expect(labels.some((label) => label.includes('Lista de atenção'))).toBe(
      true,
    );
  });

  it('abre a lista de atenção e fecha o palette', () => {
    const host = render(<CommandPalette />);
    act(() => actionButton(host, 'Lista de atenção').click());
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useAttentionInboxStore.getState().open).toBe(true);
  });

  it('oferece "Reportar um problema…" sem atalho novo, fecha o palette e abre o diálogo', () => {
    const host = render(<CommandPalette />);
    const action = actionButton(host, 'Reportar um problema…');
    // Sem atalho próprio: nenhum acelerador novo (nem conflito com os existentes).
    expect(action.querySelector('kbd')).toBeNull();
    act(() => action.click());
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useBugReportDialogStore.getState().isOpen).toBe(true);
  });

  it('acha o comando por palavras de busca naturais (bug, erro, problema)', () => {
    const host = render(<CommandPalette />);
    const input = host.querySelector<HTMLInputElement>('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'bug');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(actionButton(host, 'Reportar um problema…')).toBeDefined();
  });

  it('keeps a focused mission pane inside its named mission terminals', () => {
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: {
          id: 'pane-1',
          kind: 'shell',
          title: 'Terminal',
        },
      },
    } as never);
    // A ponte de orquestração pode conhecer a missão antes da persistência do
    // layout. O atalho precisa respeitar esse vínculo transitório também.
    useOrchStore.setState({
      paneMissions: { 'pane-1': 'mission-release' },
    } as never);
    useProductNavigationStore.getState().openTaskBoard();
    const host = render(<CommandPalette />);

    act(() => actionButton(host, 'Focar: Terminal').click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('oferece Terminais da missão quando o quadro está aberto (F-005)', () => {
    useProductNavigationStore.getState().openMission('mission-release');
    const host = render(<CommandPalette />);
    act(() => actionButton(host, 'Terminais da missão').click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
  });
});

describe('CommandPalette Retomar missão', () => {
  const mission = (over: Record<string, unknown> = {}) =>
    ({ id: 'm1', title: 'Entrega', description: '', status: 'running', milestones: [], learnings: '', createdAt: 1, updatedAt: 1, ...over }) as never;

  beforeEach(() => reopen.confirm.mockClear());

  it('lista "Retomar missão: <título>" e reabre a missão pelo mesmo caminho da toolbar', () => {
    useOrchStore.setState({ missions: [mission()], paneMissions: {} } as never);
    const host = render(<CommandPalette />);
    act(() => actionButton(host, 'Retomar missão: Entrega').click());
    expect(reopen.confirm).toHaveBeenCalledOnce();
    expect(reopen.confirm.mock.calls[0]![0]).toMatchObject({ id: 'm1' });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('não oferece retomada com sessão viva nem quando a missão espera resposta', () => {
    useOrchStore.setState({
      missions: [
        mission(),
        mission({ id: 'm2', title: 'Pergunta', status: 'blocked', intentState: 'blocked_user' }),
      ],
      paneMissions: { 'pane-1': 'm1' },
    } as never);
    useSessionStateStore.setState({ paneStates: new Map([['pane-1', 'busy']]) } as never);
    const host = render(<CommandPalette />);
    expect(host.textContent).not.toContain('Retomar missão:');
  });
});

describe('CommandPalette modal focus', () => {
  let frames: FrameRequestCallback[] = [];
  let invoker: HTMLButtonElement;

  beforeEach(() => {
    frames = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    setActiveWorkspacePath('/projects/a');
    useCommandPaletteStore.setState({ open: false });
    invoker = document.createElement('button');
    invoker.textContent = 'Terminal do pane 1';
    document.body.appendChild(invoker);
    invoker.focus();
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
  });

  function openPalette(): HTMLElement {
    const host = render(<CommandPalette />);
    act(() => useCommandPaletteStore.setState({ open: true }));
    return host;
  }

  function paint(): void {
    act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });
  }

  function press(key: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(event);
    });
    return event;
  }

  it('declares a modal dialog and keeps Tab and Shift+Tab inside it', () => {
    const host = openPalette();
    paint();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    const input = host.querySelector<HTMLInputElement>('.palette__input');
    const options = host.querySelectorAll<HTMLButtonElement>(
      'button[role="option"]',
    );
    const lastOption = options[options.length - 1];

    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input);

    expect(press('Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(lastOption);
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(invoker);
  });

  it('returns focus to the invoker when Escape dismisses the palette', () => {
    const host = openPalette();
    paint();

    press('Escape');

    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it('cancels the pending input focus when it closes before the frame', () => {
    openPalette();
    const frameId = frames.length;

    act(() => useCommandPaletteStore.getState().close());
    paint();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(frameId);
    expect(document.activeElement).toBe(invoker);
  });

  it('leaves focus alone when the invoker was removed while open', () => {
    openPalette();
    paint();
    invoker.remove();

    expect(() => press('Escape')).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not restore focus into another workspace', () => {
    openPalette();
    paint();

    act(() => {
      setActiveWorkspacePath('/projects/b');
      useCommandPaletteStore.getState().close();
    });

    expect(document.activeElement).not.toBe(invoker);
  });

  it('lets a chosen action own focus instead of the invoker', () => {
    const host = openPalette();
    paint();

    act(() => actionButton(host, 'Lista de atenção').click());

    expect(useAttentionInboxStore.getState().open).toBe(true);
    expect(document.activeElement).not.toBe(invoker);
  });
});

describe('CommandPalette modos de arquivo, conteúdo e submenu', () => {
  const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');
  let api: {
    files: { search: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
    searchMixer: { search: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    api = {
      files: {
        search: vi.fn(async () => ({ ok: true, files: ['src/app.ts'] })),
        read: vi.fn(async () => ({ ok: true, content: 'export {}' })),
      },
      searchMixer: { search: vi.fn(async () => ({ hits: [] })) },
    };
    // Sem `platform`: Linux/Windows — Mod é Ctrl.
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      writable: true,
      value: api,
    });
    setActiveWorkspacePath('/projects/a');
    useCommandPaletteStore.setState({ open: true, mode: 'command' });
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
    else Reflect.deleteProperty(window, 'nexus');
  });

  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(event);
    });
    return event;
  }

  function type(host: HTMLElement, text: string): void {
    const input = host.querySelector<HTMLInputElement>('.palette__input')!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function settleSearch(ms = 160): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  it('Mod+P, Mod+Shift+F e Mod+K trocam de modo no mesmo diálogo; repetir fecha', () => {
    const host = render(<CommandPalette />);

    press('p', { ctrlKey: true });
    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      mode: 'files',
    });
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(
      host.querySelector('[role="dialog"]')?.getAttribute('data-palette-mode'),
    ).toBe('files');

    press('F', { ctrlKey: true, shiftKey: true });
    expect(useCommandPaletteStore.getState().mode).toBe('content');

    press('k', { ctrlKey: true });
    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      mode: 'command',
    });

    press('k', { ctrlKey: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Backspace no vazio volta: submenu → raiz, arquivos → paleta', () => {
    const host = render(<CommandPalette />);

    act(() => actionButton(host, 'Ir para uma seção das configurações').click());
    expect(useCommandPaletteStore.getState().open).toBe(true);
    expect(actionButton(host, 'Atalhos')).toBeDefined();
    expect(host.querySelector('[aria-label="Voltar de Configurações"]')).not.toBeNull();

    expect(press('Backspace').defaultPrevented).toBe(true);
    expect(actionButton(host, 'Nova missão')).toBeDefined();
    expect(host.querySelector('.palette__back')).toBeNull();

    press('p', { ctrlKey: true });
    type(host, 'ab');
    // Com texto, Backspace é edição: continua no modo de arquivos.
    expect(press('Backspace').defaultPrevented).toBe(false);
    expect(useCommandPaletteStore.getState().mode).toBe('files');

    type(host, '');
    press('Backspace');
    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      mode: 'command',
    });
  });

  it('o submenu leva à seção escolhida das configurações', () => {
    const host = render(<CommandPalette />);
    act(() => actionButton(host, 'Ir para uma seção das configurações').click());
    act(() => actionButton(host, 'Atalhos').click());
    expect(useProductNavigationStore.getState().destination).toMatchObject({
      kind: 'settings',
      section: 'shortcuts',
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('abre o arquivo no editor quando o projeto não mudou', async () => {
    const host = render(<CommandPalette />);
    press('p', { ctrlKey: true });
    type(host, 'app');
    await settleSearch();
    expect(api.files.search).toHaveBeenCalledWith('app');

    act(() => actionButton(host, 'app.ts').click());
    await settleSearch(0);

    expect(api.files.read).toHaveBeenCalledWith('src/app.ts');
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(useContextualPanelNavStore.getState().requestedTab).toBe('editor');
  });

  it('revalida o workspace depois do await: troca de projeto não puxa o editor', async () => {
    let finishRead: (value: unknown) => void = () => undefined;
    api.files.read.mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve)),
    );
    const host = render(<CommandPalette />);
    press('p', { ctrlKey: true });
    type(host, 'app');
    await settleSearch();

    act(() => actionButton(host, 'app.ts').click());
    expect(api.files.read).toHaveBeenCalledWith('src/app.ts');

    setActiveWorkspacePath('/projects/b');
    finishRead({ ok: true, content: 'export {}' });
    await settleSearch(0);

    expect(useContextualPanelNavStore.getState().requestedTab).toBeNull();
  });

  it('descarta resultado que chega depois de trocar de projeto', async () => {
    const host = render(<CommandPalette />);
    press('p', { ctrlKey: true });
    type(host, 'app');
    setActiveWorkspacePath('/projects/b');
    await settleSearch();
    expect(host.querySelector('button[role="option"]')).toBeNull();
  });

  it('conteúdo: hit absoluto vira caminho relativo com a linha', async () => {
    api.searchMixer.search.mockResolvedValue({
      hits: [
        {
          id: 'rg:/projects/a/src/app.ts:12',
          source: 'files',
          title: 'app.ts',
          path: '/projects/a/src/app.ts',
          snippet: 'const answer = 42',
          meta: { line: 12 },
        },
      ],
    });
    const host = render(<CommandPalette />);
    press('F', { ctrlKey: true, shiftKey: true });
    type(host, 'answer');
    await settleSearch();

    expect(api.searchMixer.search).toHaveBeenCalledWith({
      text: 'answer',
      sources: ['files'],
      limit: 60,
    });
    const hit = actionButton(host, 'src/app.ts:12');
    expect(hit.textContent).toContain('const answer = 42');
    act(() => hit.click());
    await settleSearch(0);
    expect(api.files.read).toHaveBeenCalledWith('src/app.ts');
  });

  it('sem arquivo com esse nome, oferece buscar no conteúdo levando o texto', async () => {
    api.files.search.mockResolvedValue({ ok: true, files: [] });
    const host = render(<CommandPalette />);
    press('p', { ctrlKey: true });
    type(host, 'answer');
    await settleSearch();

    const fallback = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Buscar no conteúdo'),
    );
    expect(fallback).toBeDefined();
    act(() => fallback!.click());
    expect(useCommandPaletteStore.getState().mode).toBe('content');
    expect(host.querySelector<HTMLInputElement>('.palette__input')?.value).toBe(
      'answer',
    );
  });
});

describe('CommandPalette histórico das CLIs (F-1171)', () => {
  it('importa o histórico a partir do pane focado', () => {
    useCommandPaletteStore.setState({ open: true, mode: 'command' });
    const host = render(<CommandPalette />);
    const input = host.querySelector<HTMLInputElement>('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'importar histórico');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => actionButton(host, 'Importar histórico das CLIs').click());
    expect(cliHistory.importWithToast).toHaveBeenCalledWith('pane-1');
  });
});
