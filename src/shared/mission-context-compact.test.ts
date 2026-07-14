// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  compactMissionContext,
  renderMissionCompact,
} from './mission-context-compact';
import { compileIntentContract } from './mission-intent';
import type { Handoff, Mission } from './orch-types';

const mission: Mission = {
  id: 'm-compact',
  title: 'Feature X',
  description: '',
  status: 'running',
  milestones: [
    {
      id: 's1',
      label: 'Scaffold API',
      status: 'done',
      evidenceIds: [],
    },
    {
      id: 's2',
      label: 'Wire UI',
      status: 'in-progress',
      evidenceIds: [],
    },
    {
      id: 's3',
      label: 'Blocked on design tokens',
      status: 'blocked',
      evidenceIds: [],
    },
  ],
  learnings: '## Engenharia\n- Preserve reducers imutáveis entre retomadas.',
  createdAt: 1,
  updatedAt: 2,
  intentContract: compileIntentContract({
    goal: 'Implementar feature X no checkout',
    intentVersion: 1,
    acceptanceCriteria: ['API responde', 'UI acessível'],
  }),
};

const handoffs: Handoff[] = [
  {
    id: 'h1',
    missionId: 'm-compact',
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'API scaffold criada com testes unitários passando.',
    artifacts: [{ path: 'src/api/x.ts' }],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState: 'submitted',
    createdAt: 10,
  },
  {
    id: 'h2',
    missionId: 'm-compact',
    status: 'blocked',
    claimTrust: 'untrusted',
    summary: 'UI espera tokens do design system — falta DESIGN.md.',
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState: 'submitted',
    createdAt: 20,
  },
];

describe('mission context compaction', () => {
  it('builds a stable compact schema from mission + handoffs', () => {
    const compact = compactMissionContext({ mission, handoffs });
    expect(compact.version).toBe(1);
    expect(compact.goal).toMatch(/feature X/i);
    expect(compact.completed).toContain('Scaffold API');
    expect(compact.inProgress).toContain('Wire UI');
    expect(compact.blocked.some((b) => /tokens/i.test(b))).toBe(true);
    expect(compact.files).toContain('src/api/x.ts');
    expect(compact.learnings.join('\n')).toContain('reducers imutáveis');
    expect(compact.charCount).toBeGreaterThan(0);
    const md = renderMissionCompact(compact);
    expect(md).toContain('Memória compacta');
    expect(md).toContain('Objetivo');
    expect(md).toContain('Aprendizados duráveis');
  });

  it('omits bulk content when over maxChars', () => {
    const longHandoffs: Handoff[] = Array.from({ length: 40 }, (_, i) => ({
      ...handoffs[0]!,
      id: `h-${i}`,
      summary: `Resultado detalhado número ${i}: ${'x'.repeat(200)}`,
      artifacts: [{ path: `src/file-${i}.ts` }],
    }));
    const compact = compactMissionContext({
      mission,
      handoffs: longHandoffs,
      maxChars: 800,
    });
    expect(compact.charCount).toBeLessThanOrEqual(900);
    expect(compact.omittedNote).toBeTruthy();
  });
});
