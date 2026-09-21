import { describe, expect, it, vi } from 'vitest';
import { parseMimoTokenPlanUsage, probeMimoTokenPlan } from './mimo-token-plan';
const auth = { uid: '123', key: 'tp-test', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' };
const usage = { code: 0, data: { usage: { items: [{ name: 'total_token', used: 20, limit: 100, percent: 0.2 }] } } };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
describe('MiMo Token Plan quota', () => {
  it('keeps reported ratio and never interprets subscription expiry as reset', () => {
    expect(parseMimoTokenPlanUsage(usage)).toEqual([{ kind: 'credits', label: 'Token Plan', usedRatio: 0.2, source: 'provider-api', confidence: 'high', remainingLabel: '80 de 100 créditos disponíveis' }]);
    expect(parseMimoTokenPlanUsage({ ...usage, currentPeriodEnd: 9999999999999 })?.[0].resetsAt).toBeUndefined();
  });
  it.each([null, {}, { code: 401, data: usage.data }, { code: 0, data: { usage: { items: [{ name: 'bad', used: 0, limit: 100, percent: 20 }] } } }])('rejects malformed/error usage %j', (value) => expect(parseMimoTokenPlanUsage(value)).toBeNull());
  it('ignores the absent compensation bucket without discarding real usage', () => {
    expect(parseMimoTokenPlanUsage({ code: 0, data: { usage: { items: [...usage.data.usage.items, { name: 'compensation_total_token', used: 0, limit: 0, percent: 0 }] } } }))?.toHaveLength(1);
  });
  it('never fetches quota for paygo or missing CLI identity', async () => {
    const fetchImpl = vi.fn();
    expect(await probeMimoTokenPlan({ ...auth, baseUrl: 'https://api.xiaomimimo.com/v1' }, fetchImpl)).toEqual({ windows: null, hint: 'unavailable' });
    expect(await probeMimoTokenPlan({ ...auth, uid: undefined }, fetchImpl)).toEqual({ windows: null, hint: 'unavailable' });
    expect(await probeMimoTokenPlan(null, fetchImpl)).toEqual({ windows: null, hint: 'no-credential' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('checks the console identity before and after quota and permits only fixed GETs', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ code: 0, data: { userId: 123 } })).mockResolvedValueOnce(response(usage)).mockResolvedValueOnce(response({ code: 0, data: { userId: '123' } }));
    expect((await probeMimoTokenPlan(auth, fetchImpl)).windows?.[0].usedRatio).toBe(0.2);
    expect(fetchImpl.mock.calls.map(c => c[0])).toEqual(['https://platform.xiaomimimo.com/api/v1/userProfile', 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage', 'https://platform.xiaomimimo.com/api/v1/userProfile']);
    expect(fetchImpl.mock.calls.every(c => c[1].method === 'GET' && c[1].redirect === 'error' && !c[1].headers?.Authorization)).toBe(true);
  });
  it('rejects a different console identity without requesting usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ code: 0, data: { userId: 'other' } }));
    expect((await probeMimoTokenPlan(auth, fetchImpl)).windows).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects account changes during quota fetch and never leaks provider errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ code: 0, data: { userId: '123' } })).mockResolvedValueOnce(response(usage)).mockResolvedValueOnce(response({ code: 0, data: { userId: 'other' } }));
    expect((await probeMimoTokenPlan(auth, fetchImpl)).windows).toBeNull();
    expect(await probeMimoTokenPlan(auth, vi.fn().mockRejectedValue(new Error('secret')))).toEqual({ windows: null, hint: 'unavailable' });
  });
});
