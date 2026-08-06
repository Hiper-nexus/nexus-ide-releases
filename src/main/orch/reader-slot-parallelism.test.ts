import { describe, expect, it } from 'vitest';
import {
  emitPlannedTasksWithContract,
  ownershipDeclaresParallelSurface,
  requiresExclusiveSlot,
} from './mission-scheduler-ownership';
import { decideSchedule, type ScheduleTask } from './mission-scheduler';

const EMPTY = { files: [], symbols: [], domains: [] } as const;
const NOW = 1_700_000_000_000;
const CONFIG = { configuredCap: 8, cores: 10, paneBudget: 14 };

/**
 * Caso HiperGO 06/08: t4 (QA de execução) e t5 (revisão sênior) são
 * `executionMode: 'read_only'` — não escrevem NADA — mas caíam como slot
 * EXCLUSIVO por terem ownership vazio. Ownership vazio num LEITOR significa
 * "não toca em nada", não "toca em tudo"; a inversão custava uma onda inteira.
 */
describe('leitor com ownership vazio não é slot exclusivo', () => {
  it('read_only sem arquivos declara superfície paralela', () => {
    // Escritor com ownership vazio continua sem poder provar disjunção.
    expect(ownershipDeclaresParallelSurface(EMPTY, 'isolated_worktree')).toBe(false);
    // Leitor não escreve: nada a colidir.
    expect(ownershipDeclaresParallelSurface(EMPTY, 'read_only')).toBe(true);
  });

  it('não carimba sequential-only num leitor', () => {
    const [reader] = emitPlannedTasksWithContract([
      { id: 'qa', title: 'QA', ownership: EMPTY, dependsOn: [], executionMode: 'read_only' },
    ]);

    expect(reader!.ownership.domains).not.toContain('sequential-only');
    expect(reader!.parallelEligible).toBe(true);
  });

  it('ESCRITOR com ownership vazio segue sequencial (fail-closed preservado)', () => {
    const [writer] = emitPlannedTasksWithContract([
      { id: 'impl', title: 'impl', ownership: EMPTY, dependsOn: [] },
    ]);

    expect(writer!.ownership.domains).toContain('sequential-only');
    expect(writer!.parallelEligible).toBe(false);
  });

  it('sequential-only EXPLÍCITO é respeitado mesmo num leitor', () => {
    // Quem pede árvore quiescente de propósito continua sendo atendido.
    const [reader] = emitPlannedTasksWithContract([
      {
        id: 'gate',
        title: 'gate',
        ownership: { files: [], symbols: [], domains: ['sequential-only'] },
        dependsOn: [],
        executionMode: 'read_only',
      },
    ]);

    expect(reader!.ownership.domains).toContain('sequential-only');
    expect(requiresExclusiveSlot(reader!.ownership)).toBe(true);
  });

  it('DOIS leitores compartilham a mesma onda — o ganho de largura do caso real', () => {
    const readers: ScheduleTask[] = ['t4-qa', 't5-revisao'].map((id) => ({
      id,
      status: 'pending' as const,
      dependsOn: [],
      ownership: emitPlannedTasksWithContract([
        { id, title: id, ownership: EMPTY, dependsOn: [], executionMode: 'read_only' },
      ])[0]!.ownership,
      merged: false,
    }));

    const decision = decideSchedule(readers, [], CONFIG, NOW);

    expect(decision.plan.kind).toBe('dispatch');
    expect(decision.admittedIds).toHaveLength(2);
  });
});
