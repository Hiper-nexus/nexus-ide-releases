import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * F-919: `nexus_pane_spawn({ resume })` sem adapterId deve herdar a CLI (e o
 * modelo) do pane retomado — o registro vivo ou o worker record durável
 * (missionPanes) — em vez de exigir o argumento.
 */

const h = vi.hoisted(() => ({
  spawn: vi.fn(async (_options: Record<string, unknown>, hooks?: { onPaneCreated?: (p: string) => void }) => {
    hooks?.onPaneCreated?.('pane-new');
    return { paneId: 'pane-new', sessionId: 'session-new' };
  }),
  authority: vi.fn((_sessionId: string) => null as Record<string, unknown> | null),
  semantic: vi.fn((_sessionId: string) => null as Record<string, unknown> | null),
  stdinWritable: vi.fn((_sessionId: string) => true),
  assertRouteReservation: vi.fn(),
  consumeRouteReservation: vi.fn(),
  mission: {} as Record<string, unknown>,
  panes: [] as Array<Record<string, unknown>>,
  findByPaneId: vi.fn((_paneId: string) => null as Record<string, unknown> | null),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  takePendingPaneSpawnResult: () => null,
  findPane: (ref: string) =>
    ref === 'pane-live-1'
      ? {
          paneId: 'pane-live-1',
          sessionId: 'sess-live-1',
          adapterId: 'kimi',
          model: 'kimi-k2-thinking',
          title: 'worker',
        }
      : null,
  getPaneRuntimeAuthorityBySession: (sessionId: string) => h.authority(sessionId),
}));
vi.mock('../pty/pty-manager', async (original) => ({
  ...(await original<typeof import('../pty/pty-manager')>()),
  isSessionStdinWritable: (sessionId: string) => h.stdinWritable(sessionId),
}));
vi.mock('./agent-status', async (original) => ({
  ...(await original<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: (sessionId: string) => h.semantic(sessionId),
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      assertRouteReservation: h.assertRouteReservation,
      consumeRouteReservation: h.consumeRouteReservation,
    },
    missionPanes: {
      list: () => [],
      findByPaneId: (paneId: string) => h.findByPaneId(paneId),
      record: (input: Record<string, unknown>) => input,
    },
  }),
}));
vi.mock('./task-dispatch-authority', () => ({ isTaskQueueManagedMission: () => false }));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  listAdapters: () => [
    { id: 'codex', kind: 'cli-pty', bin: 'codex', quirks: { nexusMcp: 'codex' } },
    { id: 'kimi', kind: 'cli-pty', bin: 'kimi', quirks: { nexusMcp: 'kimi' } },
  ],
}));
vi.mock('./squad-store', async (original) => ({
  ...(await original<typeof import('./squad-store')>()),
  findAgentInAnySquad: () => null,
  getSquad: () => null,
  squadRoutableCliIds: () => new Set(['codex']),
}));
vi.mock('./operator-cli-mentions', () => ({
  OPERATOR_CHOICE_PROOF_WINDOW_MS: 30 * 60_000,
  operatorRecentlyNamedCli: vi.fn((): boolean => false),
}));
vi.mock('./isolated-writer-worktree', async (original) => ({
  ...(await original<typeof import('./isolated-writer-worktree')>()),
  resumeIsolatedWriterWorktree: () => null,
}));
vi.mock('../adapters/cli-model-discovery', async (original) => ({
  ...(await original<typeof import('../adapters/cli-model-discovery')>()),
  discoverCliModels: () => new Map(),
}));

import { paneSpawnTool, setOperatorRouteResolver } from './tools-panes';
import { startRuntimeGateway } from '../../../scripts/runtime-gateway.mjs';

const missionCtx: AgentGateContext = {
  token: 'orch', label: 'Maestro', role: 'orchestrator', sessionId: 'orch-session',
  missionId: 'mission-a', scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};
// Na integração 0.76.192, o resume DENTRO de missão é o `captureMissionPaneResume`
// (registro durável + conversa, pin divergente recusado; ver
// mission-pane-resume.test.ts). A herança do F-919 cobre o resume fora de missão.
const ctx: AgentGateContext = { ...missionCtx, missionId: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  h.authority.mockReturnValue(null);
  h.semantic.mockReturnValue(null);
  h.stdinWritable.mockReturnValue(true);
  h.panes = [];
  h.findByPaneId.mockReturnValue(null);
  setOperatorRouteResolver(null);
  h.mission = {
    id: 'mission-a', title: 'Feature', description: '', status: 'running', squadId: undefined,
    intentContract: {
      ...compileIntentContract({ goal: 'Feature', intentVersion: 1 }),
      freeAgentChoice: true,
      workspaceBinding: { version: 1, adoptedPaneId: 'pane-operador' },
    },
  };
});

describe('nexus_pane_spawn resume sem adapterId herda a CLI do pane (F-919)', () => {
  it('F-1111: the inference exchange consumes the actual ordinary tool handler success shape', async () => {
    h.findByPaneId.mockReturnValue({ paneId: 'pane-muuku9jt-8', missionId: 'mission-a', adapterId: 'codex', model: 'gpt-5.4', role: 'worker' });
    const actual = await paneSpawnTool.handler({ resume: 'pane-muuku9jt-8', prompt: 'private adjustment', task: 'private adjustment' }, ctx);
    const nonce = '11111111-1111-4111-8111-111111111111', gateway = await startRuntimeGateway(nonce);
    const messages: unknown[] = [{ role: 'user', content: `RT_GATE RECOVER ${nonce} pane-muuku9jt-8 session-old` }];
    const post = () => fetch(`${gateway.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': `rt-${nonce}` },
      body: JSON.stringify({ tools: [{ name: 'nexus_pane_spawn' }], messages }) });
    try {
      const events = (await (await post()).text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const call = events.find(event => event.type === 'content_block_start').content_block;
      call.input = JSON.parse(events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json);
      messages.push({ role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(actual) }] });
      expect((await post()).status).toBe(200);
      expect(await (await fetch(`${gateway.url}/runtime-recovery`, { headers: { 'x-api-key': `rt-${nonce}` } })).json()).toMatchObject({
        recovery: { fromPaneId: 'pane-muuku9jt-8', fromSessionId: 'session-old', paneId: 'pane-new', sessionId: 'session-new' } });
    } finally { await gateway.close(); }
  });
  it('pane fechado: herda adapterId/model do worker record durável', async () => {
    h.findByPaneId.mockReturnValue({
      paneId: 'pane-muuku9jt-8',
      missionId: 'mission-a',
      adapterId: 'codex',
      model: 'gpt-5.4',
      role: 'worker',
    });
    await paneSpawnTool.handler(
      { resume: 'pane-muuku9jt-8', prompt: 'ajuste o login', task: 'ajuste o login' },
      ctx,
    );
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-5.4',
      resume: true,
      resumeFromPaneId: 'pane-muuku9jt-8',
    });
  });

  it('pane vivo: herda adapterId/model do registro vivo', async () => {
    await paneSpawnTool.handler(
      { resume: 'pane-live-1', prompt: 'continue', task: 'continue' },
      ctx,
    );
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({
      adapterId: 'kimi',
      model: 'kimi-k2-thinking',
      resume: true,
      resumeFromPaneId: 'pane-live-1',
    });
  });

  it('o registro do pane vence o adapterId passado (trocar a CLI perderia a conversa)', async () => {
    h.findByPaneId.mockReturnValue({
      paneId: 'pane-muuku9jt-8',
      missionId: 'mission-a',
      adapterId: 'codex',
      model: 'gpt-5.4',
      role: 'worker',
    });
    await paneSpawnTool.handler(
      { adapterId: 'kimi', resume: 'pane-muuku9jt-8', task: 'olha o repo' },
      ctx,
    );
    expect(h.spawn.mock.calls[0][0]).toMatchObject({
      adapterId: 'codex',
      resume: true,
      resumeFromPaneId: 'pane-muuku9jt-8',
    });
  });

  it('dentro de missão: resume desconhecido é recusado pelo registro durável (fail-closed)', async () => {
    await expect(
      paneSpawnTool.handler({ resume: 'pane-fantasma-9', task: 'olha o repo' }, missionCtx),
    ).rejects.toThrow(/resume_unavailable/);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('resume desconhecido sem adapterId continua recusado (fail-closed)', async () => {
    await expect(
      paneSpawnTool.handler({ resume: 'pane-fantasma-9', task: 'olha o repo' }, ctx),
    ).rejects.toThrow(/adapterId/);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
