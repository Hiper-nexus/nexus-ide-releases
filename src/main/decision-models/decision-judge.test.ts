import { describe, expect, it, vi } from 'vitest';
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../persistence/secrets-store', () => ({ getSecret: () => null, hasSecret: () => false, setSecret: () => ({ ok: true }), isSecureStorageAvailable: () => true }));
vi.mock('../jev/jev-decision-log', () => ({ recordJevNoAnswer: vi.fn(() => 'id'), recordJevDecision: vi.fn(() => 'id') }));
import { recordJevDecision, recordJevNoAnswer } from '../jev/jev-decision-log';

import { judgeDecision } from './decision-judge';
import { bumpDecisionCredentialRevision } from './decision-revision';
import type { DecisionSettings } from '../../shared/decision-models';

const settings: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false };
const input = { state: 'choose a tool', questions: { q: { type: 'noul' as const, instructions: 'Is it relevant?' } }, surface: 'toolPick' as const };
const nativeResult = { model: 'jev-1.13.0', answers: { q: { type: 'noul' as const, noul: 0.8 } }, usage: { input_tokens: 100, output_tokens: 0 } };
const connection = { accountId: settings.cloudflareAccountId, token: 'synthetic-token', model: 'clef' as const };

describe('common decision service', () => {
  it.each(['auto', 'luna', 'together'] as const)('%s: ausência de rota publica zero antes da falha, sem duplicar o diário', async mode => {
    vi.mocked(recordJevNoAnswer).mockClear();
    const onUsage = vi.fn();
    const onNoAnswer = vi.fn();
    const nativeJudge = vi.fn(async () => nativeResult);
    const fetcher = vi.fn(async () => Response.json({}));

    const result = await judgeDecision({ ...input, onUsage, onNoAnswer }, {
      nativeJudge, fetch: fetcher as typeof fetch, getSettings: () => ({ ...settings, mode }),
      getAvailability: () => ({ jev: false, clef: false, luna: mode === 'together' }),
      getQualityTable: () => null, getConfigurationKey: () => 'stable',
    });

    expect(result).toBeNull();
    expect(nativeJudge).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 0, usd: 0, requestCount: 0, durationMs: 0, usageIncomplete: false });
    expect(onNoAnswer).toHaveBeenCalledExactlyOnceWith('client-error');
    expect(onUsage.mock.invocationCallOrder[0]).toBeLessThan(onNoAnswer.mock.invocationCallOrder[0]);
    expect(recordJevNoAnswer).toHaveBeenCalledTimes(mode === 'luna' ? 0 : 1);
  });

  it('preserves the no-throw contract when configuration cannot be read', async () => {
    const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, onNoAnswer }, {
      nativeJudge: async () => nativeResult,
      getSettings: () => { throw new Error('private configuration failure'); },
    });
    expect(result).toBeNull(); expect(onNoAnswer).toHaveBeenCalledWith('internal-error');
  });
  it('tells an internal failure apart from a network one and warns once, with the error name only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 1_000_000;
    const deps = { nativeJudge: async () => nativeResult, now: () => clock,
      getSettings: (): DecisionSettings => { throw new TypeError('private configuration failure with sk-secret'); } };
    const first = vi.fn(); const second = vi.fn();
    await judgeDecision({ ...input, onNoAnswer: first }, deps);
    await judgeDecision({ ...input, onNoAnswer: second }, deps);
    expect(first).toHaveBeenCalledWith('internal-error'); expect(second).toHaveBeenCalledWith('internal-error');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('TypeError');
    expect(String(warn.mock.calls[0])).not.toContain('private configuration failure');
    expect(String(warn.mock.calls[0])).not.toContain('sk-secret');
    clock += 120_000;
    await judgeDecision({ ...input }, deps);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  it('records a failure before any HTTP request as a measured zero, not an unknown count', async () => {
    const controller = new AbortController(); controller.abort();
    const onUsage = vi.fn();
    await judgeDecision({ ...input, signal: controller.signal, onUsage }, {
      nativeJudge: async () => nativeResult, getSettings: () => settings,
      getAvailability: () => ({ jev: true, clef: true }), getConfigurationKey: () => 'stable',
    });
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'aborted',
      usage: expect.objectContaining({ requestCount: 0, usageIncomplete: false }) }));
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 0, usd: 0, requestCount: 0, durationMs: 0, usageIncomplete: false });
    onUsage.mockClear();
    await judgeDecision({ ...input, onUsage }, { nativeJudge: async () => nativeResult, getSettings: () => settings,
      getAvailability: () => ({ jev: true, clef: true }), getConfigurationKey: () => 'stable', getClefConnection: () => undefined });
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'client-error',
      usage: expect.objectContaining({ requestCount: 0 }) }));
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 0, usd: 0, requestCount: 0, durationMs: 0, usageIncomplete: false });
  });
  it('calls the selected Cloudflare endpoint and attaches the actual provider receipt', async () => {
    let endpoint = ''; let nativeCalls = 0;
    const result = await judgeDecision(input, {
      nativeJudge: async () => { nativeCalls++; return nativeResult; },
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }),
      getConfigurationKey: () => 'stable', getClefConnection: () => connection,
      fetch: (async (url, options) => { endpoint = String(url); const body = JSON.parse(String(options?.body));
        return Response.json({ success: true, result: { ...nativeResult, model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) } }); }) as typeof fetch,
    });
    // F-1165: no Automático, escolha barata de texto vai ao Flash (antes: Clef cheio sempre).
    expect(endpoint).toMatch(/\/ai\/run\/@cf\/cloudflare\/clef-flash$/);
    expect(nativeCalls).toBe(0);
    expect(result?.route).toMatchObject({ provider: 'clef', model: 'clef-flash', evidence: 'prior', policyVersion: 'decision-engine-v2' });
    expect(result?.estimatedUsd).toBeCloseTo(0.0000038, 10);
  });

  it('returns a Jev answer whose provider omitted usage without inventing a cost or failing', async () => {
    const { usage: _omitted, ...withoutUsage } = nativeResult;
    const result = await judgeDecision({ ...input, surface: 'intake' }, {
      nativeJudge: async () => ({ ...withoutUsage, usage: { input_tokens: 0, output_tokens: 0 }, usageMissing: true as const }),
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }), getConfigurationKey: () => 'stable',
    });
    expect(result?.route?.provider).toBe('jev');
    expect(result?.usageMissing).toBe(true);
    expect(result?.estimatedUsd).toBeUndefined();
  });

  it('discards an answer when the user changes configuration during inference', async () => {
    let revision = 'before'; const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, surface: 'intake', onNoAnswer }, {
      nativeJudge: async () => { revision = 'after'; return nativeResult; },
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }),
      getConfigurationKey: () => revision,
    });
    expect(result).toBeNull(); expect(onNoAnswer).toHaveBeenCalledWith('aborted');
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 100, usageIncomplete: false }) }));
  });

  it('keeps the real Luna partial measurement when configuration revokes a two-batch response', async () => {
    let revision = 'before'; let requests = 0;
    vi.mocked(recordJevNoAnswer).mockClear();
    const onNoAnswer = vi.fn();
    const onUsage = vi.fn();
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, input.questions.q]));
    const result = await judgeDecision({ ...input, surface: 'intake', questions, onNoAnswer, onUsage }, {
      nativeJudge: async () => { throw new Error('Luna-only must not call the native transport'); },
      getSettings: () => ({ ...settings, mode: 'luna' }), getAvailability: () => ({ jev: false, clef: false, luna: true }),
      getConfigurationKey: () => revision, resolveLunaKey: () => 'synthetic-luna', now: () => 100,
      fetch: (async (_url, options) => {
        requests += 1;
        const body = JSON.parse(String(options?.body)) as { questions: { name: string }[] };
        if (requests === 2) revision = 'after';
        return Response.json({ model: 'gpt-6-luna', ...(requests === 1 ? { usage: { input_tokens: 1_000 } } : {}),
          answers: body.questions.map(question => ({ type: 'predicate', name: question.name, probability: 0.9 })) });
      }) as typeof fetch,
    });
    expect(requests).toBe(2); expect(result).toBeNull();
    expect(onNoAnswer).toHaveBeenCalledOnce(); expect(onNoAnswer).toHaveBeenCalledWith('aborted');
    expect(recordJevNoAnswer).toHaveBeenCalledOnce();
    expect(recordJevNoAnswer).toHaveBeenCalledWith(expect.objectContaining({ reason: 'aborted',
      usage: { inputTokens: 1_000, usd: 0.0001, requestCount: 2, durationMs: 0, usageIncomplete: true } }));
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 1_000, usd: 0.0001, requestCount: 2, durationMs: 0, usageIncomplete: true });
    expect(onUsage.mock.invocationCallOrder[0]).toBeLessThan(onNoAnswer.mock.invocationCallOrder[0]);
  });

  it('does not fall back to Jev after a Clef request is revoked', async () => {
    const controller = new AbortController(); let nativeCalls = 0;
    const result = await judgeDecision({ ...input, signal: controller.signal }, {
      nativeJudge: async () => { nativeCalls++; return nativeResult; },
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }),
      getConfigurationKey: () => 'stable', getClefConnection: () => connection,
      fetch: (async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); }) as typeof fetch,
    });
    expect(result).toBeNull(); expect(nativeCalls).toBe(0);
  });

  it('calls the Decisions API in Luna-only mode and does not fall back to Jev', async () => {
    let endpoint = ''; let nativeCalls = 0;
    const result = await judgeDecision({ ...input, surface: 'intake', state: 'sk-abcdefghijklmnopqrstuvwxyz' }, {
      nativeJudge: async () => { nativeCalls++; return nativeResult; },
      getSettings: () => ({ ...settings, mode: 'luna' }), getAvailability: () => ({ jev: true, clef: true, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async (url, options) => {
        endpoint = String(url);
        const body = JSON.parse(String(options?.body));
        expect(body.input).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
        expect(String(options?.body)).not.toContain('sk-luna-secret');
        return Response.json({ usage: { input_tokens: 1_000_000 }, answers: body.questions.map((question: { name: string }) => (
          { type: 'predicate', name: question.name, probability: 0.4 })) });
      }) as typeof fetch,
    });
    expect(endpoint).toBe('https://api.openai.com/v1/decisions');
    expect(nativeCalls).toBe(0);
    expect(result?.route).toMatchObject({ provider: 'luna', model: 'gpt-6-luna' });
    expect(result?.estimatedUsd).toBeCloseTo(0.10, 10);
    expect(result?.answers.q).toEqual({ type: 'noul', noul: 0.4 });
  });

  it('records a Luna refusal without turning it into a negative predicate or keeping the input', async () => {
    const onNoAnswer = vi.fn();
    const onUsage = vi.fn();
    const result = await judgeDecision({ ...input, surface: 'intake', state: 'private brief', onNoAnswer, onUsage }, {
      nativeJudge: async () => nativeResult,
      getSettings: () => ({ ...settings, mode: 'luna' }), getAvailability: () => ({ jev: true, clef: true, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async () => Response.json({ usage: { input_tokens: 1_000 }, answers: [{ type: 'refusal', name: 'q0' }] })) as typeof fetch,
    });
    expect(result).toBeNull();
    expect(onNoAnswer).toHaveBeenCalledWith('refusal');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ requestCount: 1, inputTokens: 1_000, usd: 0.0001 }));
    expect(onUsage.mock.invocationCallOrder[0]).toBeLessThan(onNoAnswer.mock.invocationCallOrder[0]);
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'refusal', provider: 'luna' }));
    const recorded = vi.mocked(recordJevNoAnswer).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(recorded)).not.toContain('private brief');
  });

  it('does not start another batch after credentials rotate during the first request', async () => {
    let requests = 0;
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`q${index}`, input.questions.q]));
    const result = await judgeDecision({ ...input, questions }, {
      nativeJudge: async () => nativeResult,
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }),
      getConfigurationKey: () => 'stable', getClefConnection: () => connection,
      fetch: (async (_url, options) => {
        requests++; const body = JSON.parse(String(options?.body));
        bumpDecisionCredentialRevision();
        return Response.json({ success: true, result: { ...nativeResult, model: 'clef', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) } });
      }) as typeof fetch,
    });
    expect(result).toBeNull(); expect(requests).toBe(1);
  });

  it('sends a pinned surface to Luna when the operator chose Luna, and does not call Jev', async () => {
    let nativeCalls = 0; let endpoint = '';
    const result = await judgeDecision({ ...input, surface: 'dispatchGuard', questions: { injected: input.questions.q } }, {
      nativeJudge: async () => { nativeCalls++; return nativeResult; },
      getSettings: () => ({ ...settings, mode: 'luna' }), getAvailability: () => ({ jev: true, clef: true, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async (url) => {
        endpoint = String(url);
        return Response.json({ usage: { input_tokens: 10 }, answers: [{ type: 'predicate', name: 'q0', probability: 0.2 }] });
      }) as typeof fetch,
    });
    expect(endpoint).toBe('https://api.openai.com/v1/decisions');
    expect(nativeCalls).toBe(0);
    expect(result?.route).toMatchObject({ provider: 'luna', reason: 'operator-override' });
    expect(result?.answers.injected).toEqual({ type: 'noul', noul: 0.2 });
  });

  it('records one ensemble failure, keeping the first reason', async () => {
    vi.mocked(recordJevNoAnswer).mockClear();
    const onNoAnswer = vi.fn();
    const onUsage = vi.fn();
    const result = await judgeDecision({ ...input, surface: 'dispatchGuard', state: 'private brief', onNoAnswer, onUsage, questions: { injected: input.questions.q } }, {
      nativeJudge: async (watched) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        watched.onUsage?.({ inputTokens: null, usd: null, requestCount: 1, durationMs: 20, usageIncomplete: true });
        watched.onNoAnswer?.('timeout');
        return null;
      },
      getSettings: () => ({ ...settings, mode: 'together' }), getAvailability: () => ({ jev: true, clef: false, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async () => Response.json({ answers: [{ type: 'refusal', name: 'q0' }] })) as typeof fetch,
    });
    expect(result).toBeNull();
    expect(onNoAnswer).toHaveBeenCalledTimes(1);
    expect(onNoAnswer).toHaveBeenCalledWith('refusal');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ requestCount: 2, usageIncomplete: true }));
    expect(onUsage.mock.invocationCallOrder[0]).toBeLessThan(onNoAnswer.mock.invocationCallOrder[0]);
    expect(recordJevNoAnswer).toHaveBeenCalledTimes(1);
    expect(recordJevNoAnswer).toHaveBeenCalledWith(expect.objectContaining({ reason: 'refusal' }));
    expect(JSON.stringify(vi.mocked(recordJevNoAnswer).mock.calls[0]?.[0])).not.toContain('private brief');
  });

  it('uses client-error when an ensemble member fails without a reason', async () => {
    vi.mocked(recordJevNoAnswer).mockClear();
    const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, surface: 'dispatchGuard', onNoAnswer, questions: { injected: input.questions.q } }, {
      nativeJudge: async () => null,
      getSettings: () => ({ ...settings, mode: 'together' }), getAvailability: () => ({ jev: true, clef: false, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async () => Response.json({ usage: { input_tokens: 10 }, answers: [{ type: 'predicate', name: 'q0', probability: 0.2 }] })) as typeof fetch,
    });
    expect(result).toBeNull();
    expect(onNoAnswer).toHaveBeenCalledTimes(1);
    expect(onNoAnswer).toHaveBeenCalledWith('client-error');
    expect(recordJevNoAnswer).toHaveBeenCalledTimes(1);
  });

  it('does not call Jev when together has only Luna', async () => {
    let nativeCalls = 0;
    const result = await judgeDecision({ ...input, surface: 'dispatchGuard' }, {
      nativeJudge: async () => { nativeCalls++; return nativeResult; },
      getSettings: () => ({ ...settings, mode: 'together' }), getAvailability: () => ({ jev: false, clef: false, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret', fetch: (async () => Response.json({})) as typeof fetch,
    });
    expect(result).toBeNull();
    expect(nativeCalls).toBe(0);
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'client-error' }));
  });

  it('keeps the tighter security verdict and records the divergence without the input', async () => {
    const result = await judgeDecision({ ...input, surface: 'dispatchGuard', state: 'private brief', questions: { injected: input.questions.q } }, {
      nativeJudge: async () => ({ ...nativeResult, answers: { injected: { type: 'noul' as const, noul: 0.1 } } }),
      getSettings: () => ({ ...settings, mode: 'together' }), getAvailability: () => ({ jev: true, clef: false, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async () => Response.json({ usage: { input_tokens: 1_000_000 }, answers: [{ type: 'predicate', name: 'q0', probability: 0.91 }] })) as typeof fetch,
    });
    expect(result?.answers.injected).toEqual({ type: 'noul', noul: 0.91 });
    expect(result?.diverged).toBe(true);
    expect(result?.estimatedUsd).toBeCloseTo(0.10 + 100 * 0.042 / 1_000_000, 8);
    const recorded = vi.mocked(recordJevDecision).mock.calls.at(-1)?.[0];
    expect(recorded).toMatchObject({ decision: 'diverged', diverged: true, ensemblePeers: { injected: { jev: 0.1, luna: 0.91 } } });
    expect(JSON.stringify(recorded)).not.toContain('private brief');
  });

  it('uses the higher confidence on a reversible disagreement and keeps both numbers', async () => {
    const jevChoice = { type: 'choice' as const, choice: 'm1', confidence: 0.4, probabilities: { m1: 0.4 } };
    const result = await judgeDecision({ ...input, surface: 'missionPick', state: 'private brief', questions: { pick: { type: 'choice', instructions: 'qual', criteria: { m1: null, m2: null } } } }, {
      nativeJudge: async () => ({ ...nativeResult, answers: { pick: jevChoice } }),
      getSettings: () => ({ ...settings, mode: 'together' }), getAvailability: () => ({ jev: true, clef: false, luna: true }),
      getConfigurationKey: () => 'stable', resolveLunaKey: () => 'sk-luna-secret',
      fetch: (async () => Response.json({ usage: { input_tokens: 20 }, answers: [{ type: 'choice', name: 'q0', choice: 'm2', confidence: 0.91, probabilities: [
        { value: 'm1', probability: 0.09 }, { value: 'm2', probability: 0.91 },
      ] }] })) as typeof fetch,
    });
    expect(result?.answers.pick).toMatchObject({ type: 'choice', choice: 'm2' });
    expect(result?.ensemblePeers).toEqual({ pick: { jev: 0.4, luna: expect.any(Number) } });
    const recorded = vi.mocked(recordJevDecision).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(recorded)).not.toContain('private brief');
    expect(recorded?.ensemblePeers?.pick.jev).toBe(0.4);
    expect(recorded?.ensemblePeers?.pick.luna).toBeGreaterThan(0.4);
  });
});
