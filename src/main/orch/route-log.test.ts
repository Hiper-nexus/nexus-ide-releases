import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRouteLog,
  recentRouteLog,
  recordRouteLog,
} from './route-log';

function input(overrides: Partial<Parameters<typeof recordRouteLog>[0]> = {}) {
  return {
    task: 'tarefa de teste',
    tier: 'medium',
    adapterId: 'kimi',
    model: 'kimi-code/kimi-for-coding',
    effort: 'medium',
    reason: 'medium; sinais: teste',
    ...overrides,
  };
}

describe('route log', () => {
  beforeEach(() => clearRouteLog());

  it('starts empty', () => {
    expect(recentRouteLog()).toEqual([]);
  });

  it('records a decision with its reason and a monotonic seq', () => {
    const e1 = recordRouteLog(input());
    const e2 = recordRouteLog(input({ adapterId: 'agy' }));
    expect(e2.seq).toBeGreaterThan(e1.seq);
    const recent = recentRouteLog();
    expect(recent[0].adapterId).toBe('agy'); // most-recent-first
    expect(recent[1].adapterId).toBe('kimi');
    expect(recent[0].reason).toContain('sinais');
  });

  it('truncates the task preview but keeps the reason', () => {
    const long = 'x'.repeat(500);
    const e = recordRouteLog(input({ task: long, reason: 'r'.repeat(500) }));
    expect(e.taskPreview.length).toBe(120);
    expect(e.reason.length).toBe(500);
  });

  it('caps the retained history at 50 (drops oldest)', () => {
    for (let i = 0; i < 60; i += 1) {
      recordRouteLog(input({ task: `t${i}` }));
    }
    const recent = recentRouteLog(1000);
    expect(recent.length).toBe(50);
    expect(recent[0].taskPreview).toBe('t59');
    expect(recent[recent.length - 1].taskPreview).toBe('t10');
  });

  it('limit clamps the returned slice', () => {
    for (let i = 0; i < 5; i += 1) recordRouteLog(input({ task: `t${i}` }));
    expect(recentRouteLog(3).length).toBe(3);
    expect(recentRouteLog(0)).toEqual([]);
  });

  it('preserva model e effort opcionais', () => {
    recordRouteLog(input({ model: 'glm-5.2', effort: 'high' }));
    expect(recentRouteLog()[0]).toMatchObject({ model: 'glm-5.2', effort: 'high' });
  });

  it('model/effort ausentes ficam undefined', () => {
    recordRouteLog({ task: 't', tier: 'easy', adapterId: 'kimi', reason: 'r' });
    const e = recentRouteLog()[0];
    expect(e.model).toBeUndefined();
    expect(e.effort).toBeUndefined();
  });
});
