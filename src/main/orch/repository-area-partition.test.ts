import { describe, expect, it } from 'vitest';
import { partitionOwnershipIntoAreas } from './repository-area-partition';

/**
 * Prong (b): o planner JÁ lê o inventário vivo do repositório
 * (guided-mission-planner.ts:482-489) e o achata num ownership só, para UMA
 * tarefa. Este módulo o particiona em ÁREAS disjuntas, para o plano nascer com
 * N raízes em vez de 1 — que é o que ele vê na tela.
 *
 * Conservador por contrato: só declara área quando a disjunção é PROVÁVEL.
 */
const HIPERGO = [
  'apps/web/src/app.tsx',
  'apps/web/src/home.tsx',
  'services/api/src/server.ts',
  'services/api/src/tenant.ts',
  // NB: `index.ts` seria glue RESERVADO e sairia da partição de propósito.
  'packages/contracts/src/tenant-contract.ts',
  'tests/e2e/smoke.spec.ts',
];

describe('partitionOwnershipIntoAreas', () => {
  it('separa o monorepo dele em áreas por pacote', () => {
    const areas = partitionOwnershipIntoAreas(HIPERGO);
    const ids = areas.map((a) => a.id).sort();

    expect(ids).toEqual([
      'apps/web',
      'packages/contracts',
      'services/api',
      'tests',
    ]);
  });

  it('cada arquivo aparece em exatamente UMA área (partição de verdade)', () => {
    const areas = partitionOwnershipIntoAreas(HIPERGO);
    const todos = areas.flatMap((a) => a.files);

    expect(todos.length).toBe(HIPERGO.length);
    expect(new Set(todos).size).toBe(HIPERGO.length);
  });

  it('as áreas são pairwise-disjuntas por prefixo', () => {
    const areas = partitionOwnershipIntoAreas(HIPERGO);
    for (const a of areas) {
      for (const b of areas) {
        if (a.id === b.id) continue;
        expect(a.id.startsWith(b.id + '/')).toBe(false);
      }
    }
  });

  it('projeto de pasta única NÃO é particionado — 1 área, e é a verdade', () => {
    const areas = partitionOwnershipIntoAreas([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);

    expect(areas).toHaveLength(1);
    expect(areas[0]!.id).toBe('src');
  });

  it('glue reservado nunca entra numa área (fica exclusivo)', () => {
    const areas = partitionOwnershipIntoAreas([
      'apps/web/src/app.tsx',
      'services/api/src/server.ts',
      'package-lock.json',
      'pnpm-lock.yaml',
    ]);
    const todos = areas.flatMap((a) => a.files);

    expect(todos).not.toContain('package-lock.json');
    expect(todos).not.toContain('pnpm-lock.yaml');
  });

  it('inventário vazio devolve zero áreas, sem inventar', () => {
    expect(partitionOwnershipIntoAreas([])).toHaveLength(0);
  });

  it('curinga de área vira a própria área, não vaza para as vizinhas', () => {
    const areas = partitionOwnershipIntoAreas([
      'services/api/**',
      'apps/web/**',
    ]);

    expect(areas.map((a) => a.id).sort()).toEqual(['apps/web', 'services/api']);
  });
});
