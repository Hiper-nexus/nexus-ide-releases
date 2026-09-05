import { describe, expect, it, vi } from 'vitest';
import {
  classifyKeyShape,
  fetchWindowsForApiKey,
  mergeWorstWindows,
  parseGenericUsageJson,
} from './key-shape-usage';
import type { QuotaWindow } from '../../shared/quota-types';

describe('classifyKeyShape', () => {
  it('classifies known prefixes', () => {
    expect(classifyKeyShape('sk-ant-oat01-abc')).toBe('claude-oauth');
    expect(classifyKeyShape('sk-ant-api03-xyz')).toBe('anthropic-api');
    expect(classifyKeyShape('sk-kimi-coding-1')).toBe('kimi-coding');
    expect(classifyKeyShape('sk-proj-openai')).toBe('openai');
    expect(classifyKeyShape('xai-abc')).toBe('xai');
    expect(classifyKeyShape('43b72c8730e745749469abcdef012345')).toBe('unknown');
  });
});

describe('parseGenericUsageJson', () => {
  it.each([0, 0.5, 1, 50, 100])('interprets explicit percent %s on a 0–100 scale', (percent) => {
    expect(parseGenericUsageJson({ used_percent: percent })[0]?.usedRatio).toBe(percent / 100);
  });
  it('reads percent and used/limit', () => {
    const a = parseGenericUsageJson({ five_hour_percent: 40, weekly_percent: 10 });
    expect(a.find((w) => w.kind === 'hours')?.usedRatio).toBe(0.4);
    const b = parseGenericUsageJson({ used: 25, limit: 100 });
    expect(b[0]?.usedRatio).toBe(0.25);
  });
});

describe('mergeWorstWindows', () => {
  it('keeps higher usedRatio per kind/label', () => {
    const a: QuotaWindow[] = [
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: 0.2,
        source: 'provider-api',
        confidence: 'high',
      },
    ];
    const b: QuotaWindow[] = [
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: 0.8,
        source: 'provider-api',
        confidence: 'high',
      },
    ];
    const m = mergeWorstWindows([a, b]);
    expect(m).toHaveLength(1);
    expect(m[0]?.usedRatio).toBe(0.8);
  });
});

describe('fetchWindowsForApiKey', () => {
  it.each(['sk-ant-api03-test-only', 'sk-ant-oat01-test-only', 'xai-test-only', 'sk-kimi-test-only', 'unknown-provider-key-test-only', '43b72c8730e745749469abcdef012345',
    `eyJ${'a'.repeat(130)}`])('never sends an unbound credential to guessed vendor endpoints', async (key) => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }));
    expect(await fetchWindowsForApiKey(key, { fetchImpl })).toBeNull();
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it.each([
    ['sk-ant-api03-test-only', 'longcat'], ['xai-test-only', 'kimi'], ['sk-ant-oat01-test-only', 'glm'],
    [`eyJ${'a'.repeat(130)}`, 'grok'],
  ])('does not send credentials with a mismatched or unverified issuer', async (key, adapterHint) => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }));
    expect(await fetchWindowsForApiKey(key, { fetchImpl, adapterHint })).toBeNull();
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it('does not fall back from LongCat to another vendor when its quota API fails', async () => {
    const origins: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      origins.push(new URL(url).hostname);
      return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    });
    await fetchWindowsForApiKey('longcat-test-only-credential', { fetchImpl, adapterHint: 'longcat' });
    expect(new Set(origins)).toEqual(new Set(['api.longcat.chat']));
  });
  it('routes z.ai-shaped keys to GLM monitor', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('quota/limit')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              limits: [
                { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 11 },
                { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 22 },
              ],
            },
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
    const w = await fetchWindowsForApiKey('43b72c8730e745749469abcdef012345', {
      fetchImpl,
      adapterHint: 'glm',
    });
    expect(w?.find((x) => x.kind === 'hours')?.usedRatio).toBeCloseTo(0.11);
    expect(w?.find((x) => x.kind === 'weekly')?.usedRatio).toBeCloseTo(0.22);
  });
});
