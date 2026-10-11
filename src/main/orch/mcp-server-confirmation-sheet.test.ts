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
