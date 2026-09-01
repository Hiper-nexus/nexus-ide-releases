import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
}));

vi.mock('../orch/pane-registry', () => ({
  listPaneSnapshots: () => [
    { paneId: 'pane-1', sessionId: 'pty-1', title: 'Worker', state: 'busy', missionId: 'm-1' },
  ],
}));

vi.mock('../orch/project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: () => ({
    listSuites: () => [
      {
        missions: {
          list: () => [
            { id: 'm-1', title: 'Missão de teste', status: 'running', updatedAt: 1 },
          ],
        },
        handoffs: {
          list: () => [
            { id: 'h-1', status: 'success' },
          ],
        },
      },
    ],
  }),
}));

vi.mock('../orch/mcp-server', () => ({
  getMcpRuntimeInfo: () => ({ running: true, url: 'http://x', toolCount: 40 }),
}));

import { dispatchArmsTool, handleArmsJsonRpc, ARMS_TOOLS } from './arms-endpoint';
import { emitAppEvent, resetAppEventsForTests } from './app-events';

describe('arms-endpoint — superfície mínima por construção', () => {
  beforeEach(() => {
    resetAppEventsForTests();
  });

  it('tools expostas são exatamente observe e events', () => {
    expect(ARMS_TOOLS.map((tool) => tool.name).sort()).toEqual(
      ['nexus_app_events', 'nexus_app_observe'],
    );
  });

  it('qualquer outra tool é recusada pelo dispatcher', () => {
    expect(dispatchArmsTool('nexus_pane_spawn', {}).ok).toBe(false);
    expect(dispatchArmsTool('nexus_file_write', {}).ok).toBe(false);
    expect(dispatchArmsTool('nexus_shell_exec', {}).ok).toBe(false);
  });

  it('observe projeta missões/panes/handoffs sem conteúdo de terminal', () => {
    const result = dispatchArmsTool('nexus_app_observe', {}).result as {
      missions: unknown[];
      panes: unknown[];
      handoffsPending: number;
    };
    expect(result.missions).toEqual([
      { id: 'm-1', title: 'Missão de teste', status: 'running', updatedAt: 1 },
    ]);
    expect(result.panes[0]).toMatchObject({ paneId: 'pane-1', state: 'busy' });
    expect(result.handoffsPending).toBe(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('output');
    expect(serialized).not.toContain('buffer');
  });

  it('events pagina por cursor e devolve nextCursor', () => {
    emitAppEvent('pane.spawned', { role: 'worker' });
    const page1 = dispatchArmsTool('nexus_app_events', { after: 0 }).result as {
      events: Array<{ kind: string }>;
      nextCursor: number;
    };
    expect(page1.events).toHaveLength(1);
    emitAppEvent('handoff.delivered', { handoffId: 'h-1' });
    const page2 = dispatchArmsTool('nexus_app_events', {
      after: page1.nextCursor,
    }).result as { events: Array<{ kind: string }> };
    expect(page2.events.map((event) => event.kind)).toEqual([
      'handoff.delivered',
    ]);
  });

  it('JSON-RPC: initialize/tools/list/tools/call e método inexistente', () => {
    const responses = handleArmsJsonRpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'nexus_app_observe', arguments: {} },
      },
      { jsonrpc: '2.0', id: 4, method: 'resource/read' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    const byId = new Map(
      responses.map((response) => [response.id, response]),
    );
    expect(byId.get(1)?.result).toMatchObject({
      serverInfo: { name: 'nexus-arms' },
    });
    expect(byId.get(2)?.result).toMatchObject({ tools: ARMS_TOOLS });
    expect(byId.get(3)?.result).toMatchObject({ content: [{ type: 'text' }] });
    expect(byId.get(4)?.error).toMatchObject({ code: -32601 });
    expect(byId.has(undefined)).toBe(false); // notificação não gera resposta
  });
});
