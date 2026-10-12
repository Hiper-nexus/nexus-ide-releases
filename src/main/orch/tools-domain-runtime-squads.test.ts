import { describe, expect, it, vi } from 'vitest';

// F-1335: squads runtime de missão são evidência imutável da missão, não
// catálogo reutilizável — a UI e o export já os filtram; as ferramentas MCP não.
const RUNTIME_ID = 'mission-runtime-3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const AGENTIC_ID = 'agentic-runtime-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function squad(id: string, agentName: string) {
  return {
    id,
    name: `squad ${id}`,
    createdAt: '1700000000',
    builtin: false,
    orchestratorInstructions: 'prompt cru do operador',
    agents: [{ id: `${id}-a`, agentName, category: 'worker', cli: 'claude', effort: 'high' }],
  };
}

const saved = [
  squad('user-squad', 'revisor-react'),
  squad(RUNTIME_ID, 'revisor-runtime'),
  squad(AGENTIC_ID, 'revisor-agentic'),
];

vi.mock('./squad-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./squad-store')>();
  return {
    ...actual,
    listSquads: () => saved,
    listAgents: () =>
      saved.flatMap((s) => s.agents.map((agent) => ({ ...agent, squadId: s.id }))),
  };
});

import { buildDomainTools } from './tools-domain';

const tools = buildDomainTools();
const call = (name: string, args: Record<string, unknown> = {}) =>
  tools.find((t) => t.name === name)!.handler(args, {} as never, { current: true } as never);

describe('F-1335: runtime mission squads stay out of the MCP catalog', () => {
  it('nexus_recipe_list hides mission/agentic runtime squads', async () => {
    const res = (await call('nexus_recipe_list')) as { recipes: Array<{ id: string }> };
    const ids = res.recipes.map((r) => r.id);
    expect(ids).toContain('user-squad');
    expect(ids).not.toContain(RUNTIME_ID);
    expect(ids).not.toContain(AGENTIC_ID);
  });

  it('nexus_agent_list (catalog and ranked) hides runtime squad agents', async () => {
    const all = (await call('nexus_agent_list')) as Array<{ squadId: string }>;
    expect(all.map((a) => a.squadId)).toEqual(['user-squad']);

    const ranked = (await call('nexus_agent_list', { need: 'revisor' })) as {
      agents: Array<{ squadId: string }>;
    };
    expect(ranked.agents.map((a) => a.squadId)).toEqual(['user-squad']);
  });
});
