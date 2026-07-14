import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle },
}));

vi.mock('../feature-flags/feature-flag-registry', () => ({
  getFeatureFlagRegistry: () => ({
    isEnabled: () => true,
  }),
}));

const projectRecent = vi.fn(() => [
  {
    sequence: 1,
    id: 'e1',
    missionId: 'm1',
    runId: 'r1',
    type: 'driver.tick',
    payload: {},
    idempotencyKey: 'k'.repeat(16),
    occurredAt: 1,
    origin: 'driver',
    deliveryStatus: 'pending',
  },
]);
const replay = vi.fn(() => []);
const ack = vi.fn(() => ({
  consumerId: 'ui-main',
  missionId: 'm1',
  lastSequence: 1,
  updatedAt: 2,
}));
const getCursor = vi.fn(() => ({
  consumerId: 'ui-main',
  missionId: 'm1',
  lastSequence: 0,
  updatedAt: 0,
}));

vi.mock('./mission-event-journal', () => ({
  MissionEventJournal: class {
    projectRecent = projectRecent;
    replay = replay;
    ack = ack;
    getCursor = getCursor;
  },
}));

vi.mock('./mission-event-emit', () => ({
  getMissionEventRuntimeManager: () => ({ id: 'runtime' }),
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireRendererWorkspaceScope: () => ({
    version: 1,
    installationId: 'i',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath: '/tmp/ws',
    identitySource: 'manifest',
  }),
}));

describe('registerMissionEventIpc', () => {
  beforeEach(() => {
    handle.mockClear();
    projectRecent.mockClear();
    ack.mockClear();
  });

  it('registers recent/replay/ack/cursor channels and routes recent', async () => {
    const { registerMissionEventIpc } = await import('./mission-event-ipc');
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');

    registerMissionEventIpc();

    const channels = handle.mock.calls.map((c) => c[0] as string);
    expect(channels).toContain(ORCH_CHANNELS.missionEventsRecent);
    expect(channels).toContain(ORCH_CHANNELS.missionEventsReplay);
    expect(channels).toContain(ORCH_CHANNELS.missionEventsAck);
    expect(channels).toContain(ORCH_CHANNELS.missionEventsCursor);

    const recentHandler = handle.mock.calls.find(
      (c) => c[0] === ORCH_CHANNELS.missionEventsRecent,
    )?.[1] as (e: { sender: unknown }, raw: unknown) => unknown;

    const result = recentHandler({ sender: {} }, { missionId: 'm1', limit: 10 });
    expect(projectRecent).toHaveBeenCalledWith('m1', 10);
    expect(result).toMatchObject({ enabled: true });
    expect((result as { events: unknown[] }).events).toHaveLength(1);

    const ackHandler = handle.mock.calls.find(
      (c) => c[0] === ORCH_CHANNELS.missionEventsAck,
    )?.[1] as (e: { sender: unknown }, raw: unknown) => unknown;
    const ackResult = ackHandler(
      { sender: {} },
      { missionId: 'm1', upToSequence: 1 },
    );
    expect(ack).toHaveBeenCalledWith('ui-main', 'm1', 1);
    expect(ackResult).toMatchObject({ ok: true });
  });
});
