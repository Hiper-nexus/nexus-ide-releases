import { describe, expect, it, vi } from 'vitest';
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({}) }));
vi.mock('../persistence/secrets-store', () => ({ getSecret: () => null, hasSecret: () => false, setSecret: () => ({ ok: true }), isSecureStorageAvailable: () => true }));
vi.mock('../jev/jev-decision-log', () => ({ recordJevNoAnswer: vi.fn(() => 'id') }));
import { recordJevNoAnswer } from '../jev/jev-decision-log';

import { judgeDecision } from './decision-judge';
import { bumpDecisionCredentialRevision } from './decision-revision';
import type { DecisionSettings } from '../../shared/decision-models';

const settings: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false };
const input = { state: 'choose a tool', questions: { q: { type: 'noul' as const, instructions: 'Is it relevant?' } }, surface: 'toolPick' as const };
const nativeResult = { model: 'jev-1.13.0', answers: { q: { type: 'noul' as const, noul: 0.8 } }, usage: { input_tokens: 100, output_tokens: 0 } };
const connection = { accountId: settings.cloudflareAccountId, token: 'synthetic-token', model: 'clef' as const };

describe('common decision service', () => {
  it('preserves the no-throw contract when configuration cannot be read', async () => {
    const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, onNoAnswer }, {
      nativeJudge: async () => nativeResult,
      getSettings: () => { throw new Error('private configuration failure'); },
    });
    expect(result).toBeNull(); expect(onNoAnswer).toHaveBeenCalledWith('network');
  });
  it('calls the selected Cloudflare endpoint and attaches the actual provider receipt', async () => {
    let endpoint = ''; let nativeCalls = 0;
    const result = await judgeDecision(input, {
      nativeJudge: async () => { nativeCalls++; return nativeResult; },
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }),
      getConfigurationKey: () => 'stable', getClefConnection: () => connection,
      fetch: (async (url, options) => { endpoint = String(url); const body = JSON.parse(String(options?.body));
        return Response.json({ success: true, result: { ...nativeResult, model: 'clef', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) } }); }) as typeof fetch,
    });
    expect(endpoint).toContain('/ai/run/@cf/cloudflare/clef');
    expect(nativeCalls).toBe(0);
    expect(result?.route).toMatchObject({ provider: 'clef', evidence: 'public-benchmark' });
    expect(result?.estimatedUsd).toBeCloseTo(0.000024, 10);
  });

  it('returns a Jev answer whose provider omitted usage without inventing a cost or failing', async () => {
    const { usage: _omitted, ...withoutUsage } = nativeResult;
    const result = await judgeDecision({ ...input, surface: 'researchTriage' }, {
      nativeJudge: async () => ({ ...withoutUsage, usage: { input_tokens: 0, output_tokens: 0 }, usageMissing: true as const }),
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }), getConfigurationKey: () => 'stable',
    });
    expect(result?.route?.provider).toBe('jev');
    expect(result?.usageMissing).toBe(true);
    expect(result?.estimatedUsd).toBeUndefined();
  });

  it('discards an answer when the user changes configuration during inference', async () => {
    let revision = 'before'; const onNoAnswer = vi.fn();
    const result = await judgeDecision({ ...input, surface: 'researchTriage', onNoAnswer }, {
      nativeJudge: async () => { revision = 'after'; return nativeResult; },
      getSettings: () => settings, getAvailability: () => ({ jev: true, clef: true }),
      getConfigurationKey: () => revision,
    });
    expect(result).toBeNull(); expect(onNoAnswer).toHaveBeenCalledWith('aborted');
    expect(recordJevNoAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 100, usageIncomplete: false }) }));
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
});
