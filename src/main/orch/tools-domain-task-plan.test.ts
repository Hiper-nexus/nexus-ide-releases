import { describe, expect, it } from 'vitest';
import type { SquadAgent } from '../../shared/orch-types';
import { mcpPlanTasksToRows } from './tools-domain';

const agents: SquadAgent[] = [
  { id: 'ag-orc', agentName: 'Coordenar', category: 'orchestrator', cli: 'claude' },
  { id: 'ag-exec', agentName: 'Implementar', category: 'executor', cli: 'codex' },
  { id: 'ag-rev', agentName: 'Revisar', category: 'reviewer', cli: 'claude' },
] as unknown as SquadAgent[];

describe('mcpPlanTasksToRows (nexus_task plan — o rastreio de verdade)', () => {
  it('mapeia tasks documentadas para rows seladas com meta embutida', () => {
    const rows = mcpPlanTasksToRows(
      [
        {
          id: 'etapa-01',
          title: 'Implementar motor',
          detail: 'Detalhe da etapa',
          agentRef: 'ag-exec',
          category: 'executor',
          dependsOn: [],
          executionMode: 'same_checkout',
        },
      ],
      agents,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      plannerId: 'etapa-01',
      title: 'Implementar motor',
      agentRef: 'ag-exec',
      agentCategory: 'executor',
    });
    expect(rows[0]!.detail).toContain('Detalhe da etapa');
    expect(rows[0]!.detail).toContain('same_checkout');
  });

  it('recusa task apontando para o orquestrador (selo é de worker)', () => {
    expect(() =>
      mcpPlanTasksToRows(
        [{ id: 'e', title: 'T', agentRef: 'ag-orc', category: 'orchestrator' }],
        agents,
      ),
    ).toThrow(/orquestrador|orchestrator/i);
  });

  it('recusa categoria divergente do roster e agentRef desconhecido', () => {
    expect(() =>
      mcpPlanTasksToRows(
        [{ id: 'e', title: 'T', agentRef: 'ag-exec', category: 'reviewer' }],
        agents,
      ),
    ).toThrow(/categor/i);
    expect(() =>
      mcpPlanTasksToRows(
        [{ id: 'e', title: 'T', agentRef: 'ag-fantasma', category: 'executor' }],
        agents,
      ),
    ).toThrow(/agent|roster/i);
  });

  it('recusa plano vazio e id duplicado com erro em pt-BR', () => {
    expect(() => mcpPlanTasksToRows([], agents)).toThrow(/vazio|1 task/i);
    expect(() =>
      mcpPlanTasksToRows(
        [
          { id: 'dup', title: 'A', agentRef: 'ag-exec', category: 'executor' },
          { id: 'dup', title: 'B', agentRef: 'ag-rev', category: 'reviewer' },
        ],
        agents,
      ),
    ).toThrow(/duplicad/i);
  });
});
