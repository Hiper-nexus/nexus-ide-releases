import { describe, expect, it, vi } from 'vitest';
import {
  planUpdateEverything,
  runUpdateEverything,
  updateEverythingLines,
} from './update-everything.logic';

describe('planUpdateEverything', () => {
  it('sem nada diz "nada para atualizar"', () => {
    const plan = planUpdateEverything({ localVersion: null, providers: [] });
    expect(plan.hasWork).toBe(false);
    expect(plan.summary).toBe('nada para atualizar');
    expect(updateEverythingLines(plan)).toEqual([]);
  });

  it('lista app + CLIs atualizáveis, ignorando as que não têm receita', () => {
    const plan = planUpdateEverything({
      localVersion: '0.77.0',
      providers: [
        { adapterId: 'claude', label: 'Claude Code', canUpdate: true },
        { adapterId: 'codex', label: 'Codex', canUpdate: true },
        { adapterId: 'muse', label: 'Muse', canUpdate: false },
      ],
    });
    expect(plan.hasWork).toBe(true);
    expect(plan.providers.map((p) => p.adapterId)).toEqual(['claude', 'codex']);
    expect(plan.summary).toContain('este app (0.77.0)');
    expect(plan.summary).toContain('2 providers');
    expect(updateEverythingLines(plan)).toEqual([
      'NexusIDE → 0.77.0',
      'Claude Code (claude)',
      'Codex (codex)',
    ]);
  });
});

describe('runUpdateEverything', () => {
  it('providers antes do install; download em paralelo', async () => {
    const order: string[] = [];
    await runUpdateEverything({
      downloadLocal: async () => {
        order.push('download');
        return true;
      },
      updateProviders: async () => {
        order.push('providers');
      },
      installLocal: async () => {
        order.push('install');
      },
    });
    expect(order.indexOf('providers')).toBeLessThan(order.indexOf('install'));
    expect(order).toContain('download');
  });

  it('download que falha pula só o install', async () => {
    const order: string[] = [];
    await runUpdateEverything({
      downloadLocal: async () => false,
      updateProviders: async () => {
        order.push('providers');
      },
      installLocal: async () => {
        order.push('install');
      },
    });
    expect(order).toEqual(['providers']);
  });
});
