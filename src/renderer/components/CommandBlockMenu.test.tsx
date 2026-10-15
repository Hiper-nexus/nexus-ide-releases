/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandBlock } from '../../shared/command-block';
import type { CommandSuggestion } from '../../shared/command-refinery';

const api = vi.hoisted(() => ({
  list: vi.fn(
    async (): Promise<{ blocks: unknown[]; error?: string }> => ({ blocks: [] }),
  ),
  suggest: vi.fn(async () => ({ suggestions: [] as CommandSuggestion[] })),
  dismiss: vi.fn(async () => ({ ok: true })),
  runSuggestion: vi.fn(async () => ({ ok: true })),
  action: vi.fn(
    async (): Promise<{
      ok: boolean;
      clipboardText?: string;
      error?: string;
    }> => ({ ok: true }),
  ),
  importCliHistory: vi.fn(
    async (): Promise<{ ok: boolean; counts?: unknown; error?: string }> => ({
      ok: true,
    }),
  ),
  searchHistory: vi.fn(
    async (): Promise<{ entries: unknown[]; hasMore: boolean; error?: string }> => ({
      entries: [],
      hasMore: false,
    }),
  ),
  ptyWrite: vi.fn(),
  writeToPane: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: () => 'session-a',
  writeToPane: (paneId: string, data: string) => {
    api.writeToPane(paneId, data);
    return true;
  },
}));
vi.mock('../state/toast-store', () => ({
  useToastStore: (selector: (state: { push: typeof api.pushToast }) => unknown) =>
    selector({ push: api.pushToast }),
}));
vi.mock('./PixelIcon', () => ({
  PixelIcon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

import { CommandBlockMenu } from './CommandBlockMenu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const suggestion: CommandSuggestion = {
  command: 'npm test',
  cwd: '/workspace/app',
  projectRoot: '/workspace',
  lastBranch: 'main',
  totalCount: 4,
  successCount: 3,
  successRate: 0.75,
  distinctDays: 2,
  dismissedCount: 0,
  lastUsed: 100,
  score: 3_100,
  scope: 'cwd',
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue({ blocks: [] });
  api.suggest.mockResolvedValue({ suggestions: [suggestion] });
  api.dismiss.mockResolvedValue({ ok: true });
  api.runSuggestion.mockResolvedValue({ ok: true });
  api.searchHistory.mockResolvedValue({ entries: [], hasMore: false });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { terminalBlock: api, pty: { write: api.ptyWrite } },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CommandBlockMenu paneId="pane-a" />));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

async function openMenu(): Promise<void> {
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Comandos do terminal"]',
  );
  await act(async () => {
    trigger!.click();
    await Promise.resolve();
  });
}

describe('CommandBlockMenu command refinery', () => {
  it('shows ranked suggestions with scope and runs through the trusted API', async () => {
    await openMenu();

    expect(api.suggest).toHaveBeenCalledWith({
      sessionId: 'session-a',
      paneId: 'pane-a',
      prefix: '',
      limit: 8,
    });
    expect(host.textContent).toContain('npm test');
    expect(host.textContent).toContain('Neste diretório');
    expect(host.textContent).toContain('75% sucesso');

    const run = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Executar sugestão: npm test"]',
    );
    await act(async () => {
      run!.click();
      await Promise.resolve();
    });
    expect(api.runSuggestion).toHaveBeenCalledWith({
      sessionId: 'session-a',
      paneId: 'pane-a',
      command: 'npm test',
      cwd: '/workspace/app',
    });
  });

  it('refines by prefix and removes an explicitly dismissed suggestion', async () => {
    await openMenu();
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Filtrar comandos"]',
    );
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setValue!.call(input, 'npm r');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.suggest).toHaveBeenLastCalledWith(
      expect.objectContaining({ prefix: 'npm r' }),
    );

    const dismiss = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dispensar sugestão: npm test"]',
    );
    await act(async () => {
      dismiss!.click();
      await Promise.resolve();
    });
    expect(api.dismiss).toHaveBeenCalledWith({
      sessionId: 'session-a',
      paneId: 'pane-a',
      command: 'npm test',
      cwd: '/workspace/app',
    });
    expect(host.textContent).not.toContain('npm test');
  });

  it('reports clipboard failure instead of claiming that a command was copied', async () => {
    api.action.mockResolvedValueOnce({
      ok: true,
      clipboardText: 'npm test',
    });
    api.list.mockResolvedValue({
      blocks: [
        createCommandBlock({
          id: 'block-copy',
          sessionId: 'session-a',
          paneId: 'pane-a',
          workspaceId: 'checkout-a',
          command: 'npm test',
          cwd: '/workspace/app',
          shell: 'zsh',
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          exitCode: 0,
          status: 'success',
          redaction: {
            redacted: false,
            denylisted: false,
            secretHits: 0,
          },
          idempotencyKey: 'a'.repeat(64),
        }),
      ],
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error('clipboard denied');
        }),
      },
    });
    await openMenu();
    const copy = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Copiar',
    );

    await act(async () => {
      copy!.click();
      await Promise.resolve();
    });

    expect(api.pushToast).toHaveBeenCalledWith(
      'warn',
      'Comando',
      'Não foi possível copiar',
    );
  });

  it('does not restore a dismissed row from an older in-flight search', async () => {
    let resolveSearch:
      | ((value: { suggestions: CommandSuggestion[] }) => void)
      | undefined;
    api.suggest
      .mockResolvedValueOnce({ suggestions: [suggestion] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSearch = resolve;
          }),
      );
    await openMenu();
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Filtrar comandos"]',
    );
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setValue!.call(input, 'npm');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const dismiss = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dispensar sugestão: npm test"]',
    );
    await act(async () => {
      dismiss!.click();
      await Promise.resolve();
    });

    await act(async () => {
      resolveSearch!({ suggestions: [suggestion] });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('npm test');
  });
});

function historyEntry(id: string, command: string, origin: 'imported' | 'recorded') {
  return {
    id,
    command,
    cwd: '/workspace',
    status: origin === 'imported' ? 'unknown' : 'success',
    startedAt: 10,
    origin,
  };
}

async function typeFilter(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Filtrar comandos"]',
  );
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setValue!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

function historySection(): HTMLElement {
  return host.querySelector<HTMLElement>('section[aria-label="Histórico persistido"]')!;
}

describe('CommandBlockMenu histórico das CLIs (F-1171)', () => {
  it('importa com estado visível e mostra as contagens', async () => {
    let finish: (value: { ok: boolean; counts: unknown }) => void = () => {};
    api.importCliHistory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await openMenu();
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Importar histórico das CLIs"]',
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    expect(api.importCliHistory).toHaveBeenCalledWith({
      sessionId: 'session-a',
      paneId: 'pane-a',
    });
    expect(button!.disabled).toBe(true);
    expect(host.textContent).toContain('Importando…');

    const searchesBefore = api.searchHistory.mock.calls.length;
    await act(async () => {
      finish({
        ok: true,
        counts: {
          files: 3,
          filesSkipped: 1,
          found: 7,
          imported: 5,
          duplicates: 2,
          skipped: 0,
          capped: false,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const status = host.querySelector('[data-testid="cli-history-import-status"]');
    expect(status?.textContent).toContain('5 importados');
    expect(status?.textContent).toContain('2 já no histórico');
    expect(status?.textContent).toContain('1 ignorado');
    expect(status?.textContent).toContain('3 arquivos');
    expect(button!.disabled).toBe(false);
    // O histórico relê o SQLite depois da importação.
    expect(api.searchHistory.mock.calls.length).toBeGreaterThan(searchesBefore);
  });

  it('mostra o erro da importação de forma legível', async () => {
    api.importCliHistory.mockResolvedValueOnce({
      ok: false,
      error: 'Importação já em andamento',
    });
    await openMenu();
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Importar histórico das CLIs"]',
    );
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    const status = host.querySelector('[data-testid="cli-history-import-status"]');
    expect(status?.textContent).toContain('Importação já em andamento');
    expect(status?.getAttribute('role')).toBe('alert');
  });

  it('lista o histórico persistido com a origem e busca pelo filtro', async () => {
    api.searchHistory.mockResolvedValue({
      entries: [
        historyEntry('h1', 'pnpm build', 'imported'),
        historyEntry('h2', 'git status', 'recorded'),
      ],
      hasMore: false,
    });
    await openMenu();
    expect(api.searchHistory).toHaveBeenCalledWith({
      sessionId: 'session-a',
      paneId: 'pane-a',
      query: '',
      limit: 20,
      offset: 0,
    });
    const section = historySection();
    expect(section.textContent).toContain('pnpm build');
    expect(section.textContent).toContain('importado');
    expect(section.textContent).toContain('git status');
    expect(section.textContent).toContain('gravado');

    await typeFilter('pnpm');
    expect(api.searchHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'pnpm', offset: 0 }),
    );
  });

  it('pagina com "Mais antigos" acumulando a lista', async () => {
    api.searchHistory
      .mockResolvedValueOnce({
        entries: [historyEntry('h1', 'echo 1', 'imported')],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        entries: [historyEntry('h2', 'echo 2', 'imported')],
        hasMore: false,
      });
    await openMenu();
    const more = [...historySection().querySelectorAll('button')].find(
      (button) => button.textContent === 'Mais antigos',
    );
    await act(async () => {
      more!.click();
      await Promise.resolve();
    });
    expect(api.searchHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 1 }),
    );
    expect(historySection().textContent).toContain('echo 1');
    expect(historySection().textContent).toContain('echo 2');
  });

  it.each([[0, 1], [1, 0]])('não duplica uma página com dois cliques e respostas na ordem %s, %s (F-1371)', async (first, second) => {
    const finishes: Array<(value: { entries: unknown[]; hasMore: boolean }) => void> = [];
    api.searchHistory
      .mockResolvedValueOnce({
        entries: [historyEntry('h1', 'echo 1', 'imported')],
        hasMore: true,
      })
      .mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    await openMenu();
    const more = historySection().querySelector<HTMLButtonElement>('.cmd-history__more')!;
    await act(async () => {
      more.click();
      more.click();
    });
    expect(finishes).toHaveLength(2);
    expect(api.searchHistory).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    const page = { entries: [historyEntry('h2', 'echo 2', 'imported')], hasMore: false };
    await act(async () => { finishes[first](page); });
    await act(async () => { finishes[second](page); });
    expect(historySection().querySelectorAll('code')).toHaveLength(2);
    expect(historySection().querySelectorAll('button[aria-label="Copiar comando: echo 2"]')).toHaveLength(1);
  });

  it('reaproveita o comando: copia ou insere no terminal sem Enter', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    api.searchHistory.mockResolvedValue({
      entries: [
        historyEntry('h1', 'pnpm build', 'imported'),
        historyEntry('h2', 'cat <<EOF\nx\nEOF', 'imported'),
      ],
      hasMore: false,
    });
    await openMenu();
    const copy = historySection().querySelector<HTMLButtonElement>(
      'button[aria-label="Copiar comando: pnpm build"]',
    );
    await act(async () => {
      copy!.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('pnpm build');

    // Várias linhas executariam no primeiro \n: só Copiar.
    const multi = [...historySection().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label')?.startsWith('Inserir no terminal: cat'),
    );
    expect(multi?.disabled).toBe(true);

    const insert = historySection().querySelector<HTMLButtonElement>(
      'button[aria-label="Inserir no terminal: pnpm build"]',
    );
    await act(async () => {
      insert!.click();
      await Promise.resolve();
    });
    expect(api.writeToPane).toHaveBeenCalledWith('pane-a', 'pnpm build');
    expect(host.querySelector('[data-testid="command-block-menu"]')).toBeNull();
  });
});
