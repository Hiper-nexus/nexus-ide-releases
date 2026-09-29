import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE } from './task-router';

/**
 * Regra do operador (29/09): todo modelo novo que entra no Nexus é usado, e
 * o mais novo vem na frente — com ou sem benchmark publicado. Dois modelos são
 * da mesma linha quando só os números de versão mudam ("gemini-3.7-flash-low"
 * e "gemini-3.8-flash-low"; "claude-opus-5" e "claude-opus-5-5").
 */
function lineOf(model: string): { stem: string; version: number[] } {
  const id = model.replace(/\[[^\]]*\]$/u, '');
  const version = (id.match(/\d+/gu) ?? []).map(Number);
  return { stem: id.replace(/\d+(?:[.-]\d+)*/gu, '#'), version };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

describe('modelo mais novo sempre (regra do operador 29/09)', () => {
  it('em cada tier, a 1ª linha de cada CLI não perde para um modelo mais novo da mesma linha', () => {
    const stale: string[] = [];
    for (const [tier, rows] of Object.entries(DEFAULT_ROUTING_TABLE)) {
      const firstByAdapter = new Map<string, string>();
      for (const row of rows) {
        if (row.model && !firstByAdapter.has(row.adapterId)) firstByAdapter.set(row.adapterId, row.model);
      }
      for (const [adapterId, model] of firstByAdapter) {
        const routed = lineOf(model);
        const candidates = BUILTIN_MODEL_CATALOG.adapters?.[adapterId]?.models ?? [];
        for (const candidate of candidates) {
          if (candidate.availability === 'api-only') continue;
          const line = lineOf(candidate.id);
          if (line.stem === routed.stem && newer(line.version, routed.version)) {
            stale.push(`${tier} ${adapterId}: ${model} < ${candidate.id}`);
          }
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it('o 1º modelo do catálogo de cada CLI roteada (o mais novo) entra na tabela', () => {
    const routed = new Set(
      Object.values(DEFAULT_ROUTING_TABLE).flatMap((rows) =>
        rows.map((row) => `${row.adapterId}:${row.model}`)),
    );
    const routedAdapters = new Set(
      Object.values(DEFAULT_ROUTING_TABLE).flatMap((rows) => rows.map((row) => row.adapterId)),
    );
    const unused: string[] = [];
    for (const [adapterId, entry] of Object.entries(BUILTIN_MODEL_CATALOG.adapters ?? {})) {
      if (!routedAdapters.has(adapterId)) continue;
      const newest = entry.models?.[0];
      if (!newest || newest.availability === 'api-only') continue;
      if (!routed.has(`${adapterId}:${newest.id}`)) unused.push(`${adapterId}:${newest.id}`);
    }
    expect(unused).toEqual([]);
  });
});
