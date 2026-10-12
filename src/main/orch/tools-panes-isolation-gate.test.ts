import { describe, expect, it, vi } from 'vitest';

// Mesmo cabeçalho de mocks de tools-panes-write-authority.test.ts: importar
// tools-panes exige pty-manager, pane-registry e pane-authz mockados.
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: vi.fn(() => true),
  orchTerminateSession: vi.fn(async () => true),
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: vi.fn(() => 'idle'),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  getPaneRuntimeAuthorityBySession: vi.fn(() => null),
  listPaneSnapshots: vi.fn(() => []),
  listVisiblePaneSnapshots: vi.fn(() => []),
  readSessionOutput: vi.fn(() => ''),
  requestMissionPaneClose: vi.fn(async () => true),
  requestPaneClose: vi.fn(async () => true),
  requestPaneSpawn: vi.fn(),
  waitForIdle: vi.fn(async () => 'idle'),
  waitForNextIdle: vi.fn(async () => 'idle'),
}));

vi.mock('./pane-authz', () => ({
  authorizePaneAccess: vi.fn(() => ({ allow: true })),
}));

import { shouldEnterIsolatedWriterPath } from './tools-panes';

describe('F-1318: isolatedWriter explícito vence readOnly', () => {
  it('leitor com isolatedWriter entra no caminho de alocação da worktree', () => {
    expect(
      shouldEnterIsolatedWriterPath({
        hasAllocation: false, spawnReadOnly: true, isolatedWriterRequested: true,
      }),
    ).toBe(true);
  });

  it('leitor sem isolatedWriter continua no checkout (sem worktree)', () => {
    expect(
      shouldEnterIsolatedWriterPath({
        hasAllocation: false, spawnReadOnly: true, isolatedWriterRequested: false,
      }),
    ).toBe(false);
  });

  it('writer comum entra sem alocado e não realoca com worktree pronta', () => {
    expect(
      shouldEnterIsolatedWriterPath({
        hasAllocation: false, spawnReadOnly: false, isolatedWriterRequested: false,
      }),
    ).toBe(true);
    expect(
      shouldEnterIsolatedWriterPath({
        hasAllocation: true, spawnReadOnly: false, isolatedWriterRequested: true,
      }),
    ).toBe(false);
  });
});
