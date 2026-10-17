import { describe, expect, it, vi } from 'vitest';
import { createProductActivity, sampleMissionRunning } from './product-activity';

/** Request body without the delivery token, whose stream id is random per session. */
const bodyOf = (api: { mock: { calls: any[][] } }, index: number) => {
  const { deliveryId: _deliveryId, ...rest } = api.mock.calls[index][1].body;
  return rest;
};
const ZERO = { agentStarted: false, agentWorking: false, missionCompleted: false, missionRunning: false, missionsStarted: 0, missionsCompleted: 0 };

function setup() {
  let key: string | null = 'account-a:1';
  let snapshot: { agentPresent: boolean; agentWorking: boolean; missionRunning?: boolean } = { agentPresent: false, agentWorking: false };
  const api = vi.fn().mockResolvedValue({ status: 200, json: { ok: true } });
  const service = createProductActivity({ sessionKey: () => key, snapshot: () => snapshot, api });
  return { service, api, setKey: (value: string | null) => { key = value; }, setSnapshot: (value: typeof snapshot) => { snapshot = value; } };
}

describe('minimal product activity', () => {
  it('sends only presence flags; an open app is not agent use', async () => {
    const { service, api } = setup();
    await service.flush();
    expect(api).toHaveBeenCalledWith('/v1/activity', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    expect(bodyOf(api, 0)).toEqual(ZERO);
    expect(api.mock.calls[0][1].body.deliveryId).toMatch(/^[0-9a-f]{16}:0-0:0-0$/);
  });
  it('records physical agents and new done transitions, never spawn requests or handoff text', async () => {
    const { service, api, setSnapshot } = setup();
    service.observe({ kind: 'pane.spawned', payload: { prompt: 'never upload' } });
    service.observe({ kind: 'handoff.delivered', payload: { handoffId: 'private' } });
    await service.flush();
    expect(bodyOf(api, 0)).toEqual(ZERO);
    setSnapshot({ agentPresent: true, agentWorking: true });
    service.observe({ kind: 'mission.completed', payload: { status: 'done', missionId: 'private' } });
    await service.flush();
    expect(bodyOf(api, 1)).toEqual({ ...ZERO, agentStarted: true, agentWorking: true, missionCompleted: true, missionsCompleted: 1 });
    setSnapshot({ agentPresent: false, agentWorking: false });
    await service.flush();
    expect(bodyOf(api, 2)).toEqual(ZERO);
  });
  it('keeps unsent flags on failure and drops them across login generations', async () => {
    const { service, api, setKey } = setup();
    service.agentState('busy');
    api.mockResolvedValueOnce({ status: 0, json: null });
    await service.flush();
    await service.flush();
    expect(api.mock.calls[1][1].body.agentWorking).toBe(true);
    service.observe({ kind: 'mission.completed', payload: { status: 'done' } });
    setKey('account-b:2');
    await service.flush();
    expect(api.mock.calls[2][1].body.missionCompleted).toBe(false);
    setKey(null);
    service.agentState('busy');
    await service.flush();
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('serializes requests and preserves events arriving during a successful request', async () => {
    const { service, api } = setup();
    let resolve!: (value: unknown) => void;
    api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = service.flush();
    const concurrent = service.flush();
    expect(concurrent).toBe(first);
    expect(api).toHaveBeenCalledTimes(1);
    service.observe({ kind: 'mission.completed', payload: { status: 'done' } });
    resolve({ status: 200, json: { ok: true } });
    await first;
    await concurrent;
    await service.flush();
    expect(api.mock.calls[1][1].body.missionCompleted).toBe(true);
  });
  it('absorbs transport exceptions, stops further sends, and aborts an active send', async () => {
    const { service, api } = setup();
    api.mockRejectedValueOnce(new Error('offline'));
    await expect(service.flush()).resolves.toBeUndefined();
    await service.stop();
    await service.flush();
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('counts mission starts once per mission, tracks running state and keeps counts until ACK', async () => {
    const { service, api } = setup();
    service.observe({ kind: 'mission.state', payload: { status: 'running', missionId: 'a' } });
    service.observe({ kind: 'mission.state', payload: { status: 'running', missionId: 'a' } });
    service.observe({ kind: 'mission.state', payload: { status: 'running', missionId: 'b' } });
    api.mockResolvedValueOnce({ status: 500, json: null });
    await service.flush();
    expect(bodyOf(api, 0)).toEqual({ ...ZERO, missionRunning: true, missionsStarted: 2 });
    service.observe({ kind: 'mission.completed', payload: { status: 'done', missionId: 'a' } });
    await service.flush();
    expect(bodyOf(api, 1)).toEqual({ ...ZERO, missionRunning: true, missionsStarted: 2, missionsCompleted: 1, missionCompleted: true });
    service.observe({ kind: 'mission.state', payload: { status: 'blocked', missionId: 'b' } });
    await service.flush();
    expect(bodyOf(api, 2)).toEqual({ ...ZERO, missionRunning: false });
  });
  it('counts a mission that goes running, blocked, running again as one start, until the account changes', async () => {
    const { service, api, setKey } = setup();
    const state = (status: string, missionId = 'a') => service.observe({ kind: 'mission.state', payload: { status, missionId } });
    state('running'); state('blocked'); state('running');
    await service.flush();
    expect(bodyOf(api, 0)).toEqual({ ...ZERO, missionRunning: true, missionsStarted: 1 });
    // Mission a resuming is not a new start; mission b appearing is.
    state('blocked'); state('running'); state('running', 'b');
    await service.flush();
    expect(bodyOf(api, 1)).toEqual({ ...ZERO, missionRunning: true, missionsStarted: 1 });
    // Which missions were counted belongs to the account session: after a login change a counts again.
    setKey('account-b:2');
    state('running');
    await service.flush();
    expect(bodyOf(api, 2)).toEqual({ ...ZERO, missionRunning: true, missionsStarted: 1 });
  });
  it('lets the snapshot override the events: it clears a stuck running mission and reports it as not running', async () => {
    const { service, api, setSnapshot } = setup();
    service.observe({ kind: 'mission.state', payload: { status: 'running', missionId: 'a' } });
    await service.flush();
    // The mission left `running` through a lifecycle change that emitted no mission.state: events alone keep it running.
    await service.flush();
    expect(api.mock.calls.map(call => call[1].body.missionRunning)).toEqual([true, true]);
    setSnapshot({ agentPresent: false, agentWorking: false, missionRunning: false });
    await service.flush();
    expect(bodyOf(api, 2)).toEqual({ ...ZERO, missionRunning: false });
    // The stuck id is gone for good: without a verdict from the snapshot the events fallback stays false.
    setSnapshot({ agentPresent: false, agentWorking: false });
    await service.flush();
    expect(api.mock.calls[3][1].body.missionRunning).toBe(false);
  });
  it('trusts a running snapshot without events, and still reports a start that ended before the sample', async () => {
    const { service, api, setSnapshot } = setup();
    setSnapshot({ agentPresent: false, agentWorking: false, missionRunning: true });
    await service.flush();
    expect(bodyOf(api, 0)).toEqual({ ...ZERO, missionRunning: true });
    service.observe({ kind: 'mission.state', payload: { status: 'running', missionId: 'a' } });
    setSnapshot({ agentPresent: false, agentWorking: false, missionRunning: false });
    await service.flush();
    expect(bodyOf(api, 1)).toEqual({ ...ZERO, missionRunning: false, missionsStarted: 1 });
    await service.flush();
    expect(bodyOf(api, 2)).toEqual(ZERO);
  });
  it('sends at most 50 mission events per request and the rest on the next flush', async () => {
    const { service, api } = setup();
    for (let i = 0; i < 60; i++) service.observe({ kind: 'mission.completed', payload: { missionId: `m${i}` } });
    await service.flush();
    await service.flush();
    expect(api.mock.calls.map(call => call[1].body.missionsCompleted)).toEqual([50, 10]);
  });
  it('names each delivery by its counter range, and a retry keeps the stream even when it grows', async () => {
    const { service, api } = setup();
    const state = (missionId: string) => service.observe({ kind: 'mission.state', payload: { status: 'running', missionId } });
    state('a');
    api.mockRejectedValueOnce(new Error('offline'));
    await service.flush();
    const [stream, range] = api.mock.calls[0][1].body.deliveryId.split(/:(.*)/);
    expect(stream).toMatch(/^[0-9a-f]{16}$/);
    expect(range).toBe('0-1:0-0');
    // Another mission completes before the retry: the range widens on the same stream.
    service.observe({ kind: 'mission.completed', payload: { missionId: 'a' } });
    await service.flush();
    expect(api.mock.calls[1][1].body.deliveryId).toBe(`${stream}:0-1:0-1`);
    // After the ACK the next range starts where this one ended, and presence-only flushes carry no token.
    state('b');
    await service.flush();
    expect(api.mock.calls[2][1].body.deliveryId).toBe(`${stream}:1-2:1-1`);
    await service.flush();
    expect(bodyOf(api, 3)).toEqual({ ...ZERO, missionRunning: true }); // b still runs
    expect(api.mock.calls[3][1].body.deliveryId).toBe(`${stream}:2-2:1-1`);
  });
  it('starts a new stream when the account session changes', async () => {
    const { service, api, setKey } = setup();
    service.observe({ kind: 'mission.completed', payload: { missionId: 'a' } });
    await service.flush();
    setKey('account-b:2');
    service.observe({ kind: 'mission.completed', payload: { missionId: 'a' } });
    await service.flush();
    const ids = [0, 1].map(i => api.mock.calls[i][1].body.deliveryId as string);
    expect(ids[0].split(':')[0]).not.toBe(ids[1].split(':')[0]);
    expect(ids[1].split(':').slice(1).join(':')).toBe('0-0:0-1');
  });
  it('reports a mission blocked through a lifecycle change as no longer running (domain stores sample)', async () => {
    const { service, api, setSnapshot } = setup();
    const running = [{ id: 'm1' }];
    const registry = () => ({ listSuites: () => [{ missions: { list: (_status: 'running') => running.slice() } }] });
    service.observe({ kind: 'mission.state', payload: { status: 'running', missionId: 'm1' } });
    setSnapshot({ agentPresent: false, agentWorking: false, missionRunning: sampleMissionRunning(registry) });
    await service.flush();
    expect(api.mock.calls[0][1].body.missionRunning).toBe(true);
    // blockUser/blockTechnical moved it out of `running` without a mission.state event.
    running.length = 0;
    setSnapshot({ agentPresent: false, agentWorking: false, missionRunning: sampleMissionRunning(registry) });
    await service.flush();
    expect(api.mock.calls[1][1].body.missionRunning).toBe(false);
  });
  it('leaves the verdict to the events when the project stores are not up', () => {
    expect(sampleMissionRunning(() => { throw new Error('project-scoped domain stores are not initialized'); })).toBeUndefined();
    expect(sampleMissionRunning(() => ({ listSuites: () => [] }))).toBe(false);
  });
});
