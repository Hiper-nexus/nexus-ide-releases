/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionId: 'session-a' as string | null,
  importCliHistory: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: () => mocks.sessionId,
}));
vi.mock('../state/toast-store', () => ({
  useToastStore: { getState: () => ({ push: mocks.push }) },
}));

import {
  describeCliHistoryImport,
  importCliHistoryForPane,
  importCliHistoryWithToast,
} from './cli-history-import';

const base = {
  files: 0,
  filesSkipped: 0,
  found: 0,
  imported: 0,
  duplicates: 0,
  skipped: 0,
  capped: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionId = 'session-a';
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { terminalBlock: { importCliHistory: mocks.importCliHistory } },
  });
});

describe('describeCliHistoryImport', () => {
  it('resume contagens em pt-BR com plural correto', () => {
    expect(describeCliHistoryImport(base)).toBe('Nenhum transcript de CLI neste projeto');
    expect(describeCliHistoryImport({ ...base, files: 1 })).toBe(
      'Nenhum comando de shell em 1 transcript',
    );
    expect(
      describeCliHistoryImport({
        ...base,
        files: 1,
        found: 2,
        imported: 1,
        duplicates: 1,
        capped: true,
      }),
    ).toBe('1 importado · 1 já no histórico (1 arquivo) · teto atingido');
  });
});

describe('importCliHistoryForPane', () => {
  it('sem sessão viva não chama o Main e explica o porquê', async () => {
    mocks.sessionId = null;
    const result = await importCliHistoryForPane('pane-a');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Abra um terminal/);
    expect(mocks.importCliHistory).not.toHaveBeenCalled();
  });

  it('exceção do IPC vira erro legível', async () => {
    mocks.importCliHistory.mockRejectedValueOnce(new Error('canal fechado'));
    expect(await importCliHistoryForPane('pane-a')).toEqual({
      ok: false,
      error: 'canal fechado',
    });
  });

  it('a paleta responde por toast', async () => {
    mocks.importCliHistory.mockResolvedValueOnce({
      ok: true,
      counts: { ...base, files: 2, found: 3, imported: 3 },
    });
    await importCliHistoryWithToast('pane-a');
    expect(mocks.importCliHistory).toHaveBeenCalledWith({
      sessionId: 'session-a',
      paneId: 'pane-a',
    });
    expect(mocks.push).toHaveBeenCalledWith(
      'success',
      'Histórico das CLIs',
      '3 importados · 0 já no histórico (2 arquivos)',
    );
  });
});
