import { describe, expect, it } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { paneSpawnTool } from './tools-panes';

function userPane(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: 'token',
    label: 'pane do operador',
    role: 'user',
    sessionId: 'session-user',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

/**
 * Campo 09/09: o operador abriu um terminal pela opção de pane, pediu para
 * abrir outros panes e levou parede. O caminho ad-hoc (só adapterId) sempre
 * funcionou, mas a descrição da ferramenta empurra para `agentName` — e esse
 * ramo exigia missão com squad. A sessão `user` é a mão do operador e já pode
 * spawnar ad-hoc com qualquer CLI: exigir missão dela era cerimônia.
 */
describe('nexus_pane_spawn pela mão do operador', () => {
  it('não exige missão do operador que nomeia um agente do roster', async () => {
    let failure: unknown = null;
    try {
      await paneSpawnTool.handler({ agentName: 'Executor' }, userPane());
    } catch (error) {
      failure = error;
    }
    // Pode falhar por falta de runtime real no teste, mas NUNCA por missão.
    expect(String(failure ?? '')).not.toMatch(/requires a mission/i);
  });

  it('mantém a exigência de missão para quem não é o operador', async () => {
    await expect(
      paneSpawnTool.handler(
        { agentName: 'Executor' },
        userPane({ role: 'orchestrator', label: 'orch', sessionId: 'session-orch' }),
      ),
    ).rejects.toThrow(/mission/i);
  });

  it('quando o agente não existe, a recusa ensina o caminho que funciona', async () => {
    let message = '';
    try {
      await paneSpawnTool.handler(
        { agentName: 'agente-que-nao-existe' },
        userPane(),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/adapterId/);
  });
});
