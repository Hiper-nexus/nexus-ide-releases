// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  compactMissionContext,
  missionCompactHasProgress,
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

describe('missionCompactHasProgress', () => {
  it('reports no progress for a freshly dispatched mission (goal/criteria only)', () => {
    const fresh = compactMissionContext({
      mission: {
        ...mission,
        milestones: mission.milestones.map((step) => ({
          ...step,
          status: 'pending' as const,
        })),
        learnings: '',
      },
      handoffs: [],
    });
    expect(missionCompactHasProgress(fresh)).toBe(false);
    // Goal and criteria stay in the schema — they are just not "progress".
    expect(fresh.goal).toMatch(/feature X/i);
    expect(fresh.constraints.length).toBeGreaterThan(0);
  });

  it('reports progress once milestones, learnings or handoffs land', () => {
    const compact = compactMissionContext({ mission, handoffs });
    expect(missionCompactHasProgress(compact)).toBe(true);
  });
});

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
    expect(compact.charCount).toBeLessThanOrEqual(800);
    expect(renderMissionCompact(compact).length).toBeLessThanOrEqual(800);
    expect(compact.omittedNote).toBeTruthy();
  });

  it('hard-trims oversized individual fields to the exact character budget', () => {
    const compact = compactMissionContext({
      mission: {
        ...mission,
        intentContract: compileIntentContract({
          goal: 'g'.repeat(8_000),
          intentVersion: 1,
          acceptanceCriteria: Array.from({ length: 10 }, () => 'c'.repeat(2_000)),
        }),
      },
      handoffs,
      maxChars: 320,
    });
    expect(compact.charCount).toBeLessThanOrEqual(320);
    expect(renderMissionCompact(compact).length).toBe(compact.charCount);
  });

  it('rejects an invalid or structurally impossible budget', () => {
    expect(() => compactMissionContext({ mission, maxChars: 0 })).toThrow(/maxChars/i);
  });
});
