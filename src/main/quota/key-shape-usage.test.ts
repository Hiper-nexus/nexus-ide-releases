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
    expect(classifyKeyShape('43b72c8730e745749469abcdef012345')).toBe('zai');
  });
});

describe('parseGenericUsageJson', () => {
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
