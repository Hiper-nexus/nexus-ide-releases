import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConfirmationRequest } from './mcp-dispatch';

// F-1200: no macOS um showMessageBox sem janela-mãe é NSAlert runModal e prende
// a main thread até o clique. A confirmação HTTP nasce de tool call de agente.
const electron = vi.hoisted(() => ({
  windows: [] as unknown[],
  focused: null as unknown,
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1, checkboxChecked: false })),
}));
vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    getPath: () => path.join(os.tmpdir(), 'nexus-test-confirmation-sheet'),
    getAppPath: () => process.cwd(),
  },
  BrowserWindow: {
    getAllWindows: () => electron.windows,
    getFocusedWindow: () => electron.focused,
  },
  dialog: { showMessageBox: electron.showMessageBox },
}));

function fakeWindow(visible: boolean) {
  return { isDestroyed: () => false, isVisible: () => visible, isFocusable: () => true };
}

const request: McpConfirmationRequest = {
  source: 'http-mcp',
  sessionId: 'worker-night',
  workspaceId: '/tmp/ws',
  projectId: 'project',
  checkoutId: 'checkout',
  missionId: 'mission-1',
  toolName: 'nexus_terminal_run',
  args: { command: 'rm -rf dist' },
  reason: 'destructive command: rm -rf dist',
  agentLabel: 'worker',
};

// Import frio do servidor MCP inteiro: orçamento próprio, fora do corpo do teste.
let showHttpMcpConfirmation!: typeof import('./mcp-server').showHttpMcpConfirmation;
beforeAll(async () => {
  ({ showHttpMcpConfirmation } = await import('./mcp-server'));
}, 180_000);

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  electron.windows = [];
  electron.focused = null;
  electron.showMessageBox.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('confirmação HTTP de agente (F-1200)', () => {
  it('vira sheet na janela do Nexus mesmo fora de foco, nunca NSAlert sem janela-mãe', async () => {
    const win = fakeWindow(false);
    electron.windows = [win];

    await expect(showHttpMcpConfirmation(request)).resolves.toBe(true);

    expect(electron.showMessageBox).toHaveBeenCalledOnce();
    expect(electron.showMessageBox.mock.calls[0][0]).toBe(win);
    expect(electron.showMessageBox.mock.calls[0][1]).toMatchObject({ cancelId: 0 });
  });

  it('sem nenhuma janela nega na hora em vez de prender a main thread', async () => {
    await expect(showHttpMcpConfirmation(request)).resolves.toBe(false);

    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });
});

// F-1236: o sheet numa janela minimizada ou noutro Space ficava aberto sem
// prazo e, como o scheduler mostra uma confirmação por vez, segurava as de
// todas as sessões.
describe('confirmação HTTP sem resposta (F-1236)', () => {
  const TEN_MINUTES = 10 * 60_000;
  const settle = (promise: Promise<boolean>) => {
    const box: { value?: unknown } = {};
    promise.then((value) => { box.value = value; }, (error) => { box.value = error; });
    return box;
  };
  afterEach(() => vi.useRealTimers());

  it('nega ao estourar 10 min, fecha o sheet e libera a próxima da fila', async () => {
    vi.useFakeTimers();
    electron.windows = [fakeWindow(false)];
    const signals: Array<AbortSignal | undefined> = [];
    // Ninguém clica: só o abort fecha o sheet, como no Electron (vira cancelId).
    electron.showMessageBox.mockImplementationOnce((_win, options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      signals.push(signal);
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({ response: 0, checkboxChecked: false }));
      });
    });
    const { McpConfirmationScheduler } = await import('./mcp-confirmation-scheduler');
    const scheduler = new McpConfirmationScheduler(showHttpMcpConfirmation);
    const stuck = settle(scheduler.enqueue(request));
    const next = settle(scheduler.enqueue({ ...request, sessionId: 'worker-day' }));

    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    expect(stuck.value).toBeUndefined();
    expect(electron.showMessageBox).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(stuck.value).toMatchObject({
      name: 'McpConfirmationExpiredError',
      message: expect.stringMatching(/não respondeu .*10 min.*peça de novo/i),
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(electron.showMessageBox).toHaveBeenCalledTimes(2);
    expect(next.value).toBe(true);
    scheduler.close();
  });

  it('aprovar dentro do prazo continua aprovando e não deixa timer para trás', async () => {
    vi.useFakeTimers();
    electron.windows = [fakeWindow(false)];
    electron.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ response: 1, checkboxChecked: false }), TEN_MINUTES - 60_000);
    }));

    const approval = settle(showHttpMcpConfirmation(request));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 60_000);

    expect(approval.value).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
