import { describe, expect, it } from 'vitest';
import { squadSchema, squadsFileSchema } from './orch-types';

/**
 * Guards compatibility with the REAL Overclock squads.json shape (verified
 * against the user's ~/.overclock-app/squads.json): epoch-ms createdAt,
 * workers without a `cli` field, nativeInstructions, providerId mapping.
 */

describe('squadSchema (Overclock squads.json compat)', () => {
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
      ],
    });
    expect(squad.agents[0].cli).toBe('codex');
    expect(squad.agents[1].cli).toBe('agy');
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
              agentName: 'overclock-orchestrator',
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
