import { describe, expect, it } from 'vitest';
import {
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
  SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS,
  squadSchema,
  squadsFileSchema,
  strictSquadAgentSchema,
} from './orch-types';

/**
 * Guards the squads.json shape: epoch-ms createdAt, workers without a `cli`
 * field, nativeInstructions, providerId mapping.
 */

describe('squadSchema (squads.json compat)', () => {
  it('accepts epoch-ms createdAt and coerces it to string', () => {
    const squad = squadSchema.parse({
      id: 's1',
      name: 'Test',
      createdAt: 1782995184599,
      agents: [],
    });
    expect(squad.createdAt).toBe('1782995184599');
  });

  it('defaults a worker without cli to claude', () => {
    const squad = squadSchema.parse({
      id: 's1',
      name: 'Test',
      createdAt: 1,
      agents: [
        { id: 'w1', agentName: 'ux-researcher', category: 'scout', effort: 'medium' },
      ],
    });
    expect(squad.agents[0].cli).toBe('claude');
  });

  it('maps providerId to the adapter id when cli is absent', () => {
    const squad = squadSchema.parse({
      id: 's1',
      name: 'Test',
      createdAt: 1,
      agents: [
        { id: 'w1', agentName: 'x', category: 'executor', providerId: 'codex-cli' },
        { id: 'w2', agentName: 'y', category: 'reviewer', providerId: 'antigravity-cli' },
        { id: 'w3', agentName: 'z', category: 'scout', providerId: 'gemini-cli' },
      ],
    });
    expect(squad.agents[0].cli).toBe('codex');
    expect(squad.agents[1].cli).toBe('agy');
    expect(squad.agents[2].cli).toBe('agy');
  });

  it('migra cli Gemini explícita de squads persistidos para AGY', () => {
    const squad = squadSchema.parse({
      id: 's1',
      name: 'Test',
      createdAt: 1,
      agents: [
        {
          id: 'w1',
          agentName: 'legacy',
          category: 'executor',
          cli: 'gemini',
        },
      ],
    });
    expect(squad.agents[0].cli).toBe('agy');
  });

  it('preserves nativeInstructions and an explicit cli', () => {
    const squad = squadSchema.parse({
      id: 's1',
      name: 'Test',
      createdAt: '2026-07-01',
      nativeInstructions: '# native',
      agents: [
        { id: 'orq', agentName: 'orq', category: 'orchestrator', cli: 'codex' },
      ],
    });
    expect(squad.nativeInstructions).toBe('# native');
    expect(squad.agents[0].cli).toBe('codex');
  });

  it('parses a realistic multi-squad file', () => {
    const file = squadsFileSchema.parse({
      squads: [
        {
          id: 'builtin-1',
          name: 'QA Vision Lab',
          createdAt: 1782995184599,
          builtin: true,
          orchestratorInstructions: '# playbook',
          agents: [
            {
              id: 'orchestrator',
              agentName: 'nexus-orchestrator',
              category: 'orchestrator',
              cli: 'claude',
              model: 'claude-opus-4-8',
              effort: 'high',
            },
            { id: 'w', agentName: 'qa-navegador-visao', category: 'scout' },
          ],
        },
      ],
    });
    expect(file.squads[0].agents).toHaveLength(2);
    expect(file.squads[0].builtin).toBe(true);
  });
});

describe('strict SquadAgent instructions', () => {
  const baseAgent = {
    id: 'reviewer',
    agentName: 'Revisar segurança',
    category: 'reviewer' as const,
    cli: 'codex',
    allowedTools: ['Read'],
  };

  it('preserves optional operator-owned role instructions', () => {
    const parsed = strictSquadAgentSchema.parse({
      ...baseAgent,
      instructions: 'Priorize os limites de autenticação e cite arquivo:linha.',
    });

    expect(parsed.instructions).toBe(
      'Priorize os limites de autenticação e cite arquivo:linha.',
    );
    const roundTripped = strictSquadAgentSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(roundTripped.instructions).toBe(parsed.instructions);
    expect(roundTripped.allowedTools).toEqual(['Read']);
  });

  it('rejects blank, oversized, or invisible-control instructions', () => {
    for (const instructions of [
      '',
      '   ',
      'x'.repeat(SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS + 1),
      'texto\u202einvertido',
    ]) {
      expect(
        strictSquadAgentSchema.safeParse({ ...baseAgent, instructions }).success,
      ).toBe(false);
    }
  });
});

describe('mission runtime squad identities', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';

  it('keeps agentic runtime snapshots guided', () => {
    const id = `agentic-runtime-${uuid}`;
    expect(isMissionRuntimeSquadId(id)).toBe(true);
    expect(isEngineGeneratedSquadId(id)).toBe(true);
  });

  it('keeps manual runtime snapshots on their specialty orchestrator path', () => {
    const id = `mission-runtime-${uuid}`;
    expect(isMissionRuntimeSquadId(id)).toBe(true);
    expect(isEngineGeneratedSquadId(id)).toBe(false);
  });
});
