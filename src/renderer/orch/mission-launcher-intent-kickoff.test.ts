// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildIntentDispatchKickoffPrompt,
  buildMissionKickoffPrompt,
} from './mission-launcher';
import type { Squad } from '../../shared/orch-types';
import {
  compactMissionContext,
  renderMissionCompact,
} from '../../shared/mission-context-compact';
import { compileIntentContract } from '../../shared/mission-intent';

const squad = {
  id: 'navalha',
  name: 'NavalhaGO',
  orchestratorInstructions: 'You are the orchestrator.',
  agents: [
    {
      id: 'orch',
      agentName: 'Orch',
      category: 'orchestrator' as const,
      cli: 'claude',
    },
    {
      id: 'w1',
      agentName: 'Worker',
      category: 'executor' as const,
      cli: 'codex',
    },
  ],
  createdAt: '1',
  builtin: false,
} satisfies Squad;

describe('intent-first kickoff vs monstro playbook', () => {
  it('goal-scoped kickoff keeps squad identity without the bootstrap monstro', () => {
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'm1',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Form salva'],
      risk: 'normal',
      maxWorkers: 2,
    });
    expect(prompt).toContain('Corrigir o formulário de login');
    expect(prompt).toContain('Missão autorizada');
    expect(prompt).toContain('You are the orchestrator.');
    expect(prompt).toContain('Worker (executor');
    expect(prompt).toMatch(
      /workers mission-bound.*somente o Codex builtin/i,
    );
    expect(prompt).toMatch(/Kimi, OMP, Grok, AGY, OpenCode ou Claude.*falha fechado/i);
    expect(prompt).toMatch(/Terminal\/manual/i);
    expect(prompt).not.toMatch(/slots?\s+omp|Diversidade de motores/i);
    // Doctor is on-demand, not forced pre-goal bootstrap.
    expect(prompt).toMatch(/context_doctor.*sob demanda/i);
    expect(prompt).not.toMatch(/Pipeline obrigatório/i);
  });

  it('embeds compact mission memory without the legacy monstro pipeline', () => {
    const compact = compactMissionContext({
      mission: {
        id: 'm1',
        description: '',
        status: 'running',
        milestones: [],
        learnings: '',
        intentContract: compileIntentContract({
          goal: 'Corrigir o formulário de login',
          intentVersion: 1,
          acceptanceCriteria: ['Form salva'],
        }),
      },
    });
    const prompt = buildIntentDispatchKickoffPrompt({
      squad,
      missionId: 'm1',
      goal: 'Corrigir o formulário de login',
      acceptanceCriteria: ['Form salva'],
      risk: 'normal',
      maxWorkers: 2,
      compactMemoryMarkdown: renderMissionCompact(compact),
    });
    expect(prompt).toContain('Memória compacta');
    expect(prompt).not.toMatch(/Pipeline obrigatório/i);
  });

  it('legacy monstro playbook still exists only as explicit builder', () => {
    const monstro = buildMissionKickoffPrompt(squad, 'm-legacy');
    expect(monstro).toMatch(/nexus_context_doctor/i);
    expect(monstro).toMatch(/Pipeline obrigatório/i);
  });
});
