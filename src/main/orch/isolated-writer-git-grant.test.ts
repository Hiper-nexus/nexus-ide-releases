import { describe, expect, it } from 'vitest';
import type { McpRegistry, McpToolDef } from './mcp-protocol';
import { handleMcpMessage } from './mcp-protocol';
import { mintToken, resetGateForTests, type AgentGateContext } from './gate';
import { visibleToolsFor } from './tools-tool-pick';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * F-794 (B4 da Missão Terminais): o brief do writer isolado manda commitar com
 * nexus_git_add/commit, mas o worker nascia com allowlist vazia e recebia
 * "outside this agent's allowlist". F-1157 (doutrina do dono, 10/10/2026): a
 * allowlist não nega mais nada, então o writer isolado — e todo worker — vê o
 * Git inteiro. O que o handler do Git do writer isolado decide (branch
 * `nexus/…` alocada, sem push/pull/troca de branch) segue no handler
 * (`assertIsolatedWriterGitTool`), fora deste teste.
 */

const coordination = testProjectScope({ rootRealPath: '/repo/checkout' });
const worktree = testProjectScope({ rootRealPath: '/repo/worktrees/task-a' });

function worker(overrides: Partial<Parameters<typeof mintToken>[0]> = {}): AgentGateContext {
  resetGateForTests();
  return mintToken({
    label: 'Codex',
    role: 'worker',
    missionId: 'mission-a',
    scope: coordination,
    executionScope: worktree,
    allowedTools: [],
    allowedSkills: null,
    ...overrides,
  });
}

const GIT_TOOLS = ['status', 'diff', 'log', 'add', 'commit', 'push', 'pull', 'sync', 'branch_create', 'branch_switch', 'branch_list']
  .map((op) => `nexus_git_${op}`);

function tool(name: string): McpToolDef {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) };
}

const registry: McpRegistry = {
  tools: [...GIT_TOOLS, 'nexus_file_write', 'nexus_terminal_run', 'nexus_handoff_submit'].map(tool),
  serverName: 'nexus-test',
  serverVersion: '0.0.1',
};

async function listed(ctx: AgentGateContext): Promise<string[]> {
  const response = await handleMcpMessage(registry, ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const result = (response as { result: { tools: Array<{ name: string }> } }).result;
  return result.tools.map((entry) => entry.name);
}

describe('F-794/F-1157: Git e escrita ao alcance de todo worker', () => {
  it('tools/list mostra todo o Git, a escrita e o terminal ao writer isolado com allowlist vazia', async () => {
    const names = await listed(worker());
    for (const name of [...GIT_TOOLS, 'nexus_file_write', 'nexus_terminal_run', 'nexus_handoff_submit']) {
      expect(names).toContain(name);
    }
  });

  it('o worker no checkout de coordenação e o que era somente leitura também veem tudo', async () => {
    for (const ctx of [worker({ executionScope: coordination }), worker({ readOnly: true })]) {
      const names = await listed(ctx);
      for (const name of GIT_TOOLS) expect(names).toContain(name);
    }
  });

  it('nexus_tool_pick enxerga o mesmo conjunto do tools/list', async () => {
    const ctx = worker();
    const visible = visibleToolsFor(ctx, registry.tools).map((entry) => entry.name);
    expect(visible.sort()).toEqual((await listed(ctx)).sort());
  });
});
