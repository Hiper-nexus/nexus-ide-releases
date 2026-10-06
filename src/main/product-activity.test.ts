import { describe, expect, it, vi } from 'vitest';
import { createProductActivity } from './product-activity';

function setup() {
  let key: string | null = 'account-a:1';
  let snapshot = { agentPresent: false, agentWorking: false };
  const api = vi.fn().mockResolvedValue({ status: 200, json: { ok: true } });
  const service = createProductActivity({ sessionKey: () => key, snapshot: () => snapshot, api });
  return { service, api, setKey: (value: string | null) => { key = value; }, setSnapshot: (value: typeof snapshot) => { snapshot = value; } };
}

describe('minimal product activity', () => {
  it('sends only presence flags; an open app is not agent use', async () => {
    const { service, api } = setup();
    await service.flush();
    expect(api).toHaveBeenCalledWith('/v1/activity', expect.objectContaining({
      method: 'POST', redirect: 'error', body: { agentStarted: false, agentWorking: false, missionCompleted: false },
    }));
  });
  it('records physical agents and new done transitions, never spawn requests or handoff text', async () => {
    const { service, api, setSnapshot } = setup();
    service.observe({ kind: 'pane.spawned', payload: { prompt: 'never upload' } });
    service.observe({ kind: 'handoff.delivered', payload: { handoffId: 'private' } });
    await service.flush();
    expect(api.mock.calls[0][1].body).toEqual({ agentStarted: false, agentWorking: false, missionCompleted: false });
    setSnapshot({ agentPresent: true, agentWorking: true });
    service.observe({ kind: 'mission.completed', payload: { status: 'done', missionId: 'private' } });
    await service.flush();
    expect(api.mock.calls[1][1].body).toEqual({ agentStarted: true, agentWorking: true, missionCompleted: true });
    setSnapshot({ agentPresent: false, agentWorking: false });
    await service.flush();
    expect(api.mock.calls[2][1].body).toEqual({ agentStarted: false, agentWorking: false, missionCompleted: false });
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
});
