import { describe, expect, it } from 'vitest';
import type { McpRegistry, McpToolDef } from './mcp-protocol';
import { handleMcpMessage } from './mcp-protocol';
import { mintToken, resetGateForTests, type AgentGateContext } from './gate';
import { grantsIsolatedWriterGitTool } from './isolated-writer-policy';
import { visibleToolsFor } from './tools-tool-pick';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * F-794 (B4 da Missão Terminais): o brief do writer isolado manda commitar com
 * nexus_git_add/commit, mas o worker nasce com allowlist vazia — o Codex do
 * F-764 recebeu "nexus_git_status failed: tool is outside this agent's
 * allowlist" e o trabalho validado ficou sem commit. A concessão do Git da
 * própria worktree vem do contexto do Main, não do allowlist da squad.
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

const GIT_TOOLS = ['status', 'diff', 'log', 'add', 'commit'].map((op) => `nexus_git_${op}`);
const DENIED_GIT_TOOLS = ['push', 'pull', 'sync', 'branch_create', 'branch_switch', 'branch_list']
  .map((op) => `nexus_git_${op}`);

function tool(name: string): McpToolDef {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) };
}

const registry: McpRegistry = {
  tools: [...GIT_TOOLS, ...DENIED_GIT_TOOLS, 'nexus_file_write', 'nexus_terminal_run', 'nexus_handoff_submit'].map(tool),
  serverName: 'nexus-test',
  serverVersion: '0.0.1',
};

async function listed(ctx: AgentGateContext): Promise<string[]> {
  const response = await handleMcpMessage(registry, ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const result = (response as { result: { tools: Array<{ name: string }> } }).result;
  return result.tools.map((entry) => entry.name);
}

describe('Git da própria worktree para o writer isolado (F-794)', () => {
  it('concede status/diff/log/add/commit ao writer isolado mesmo com allowlist vazia', () => {
    const ctx = worker();
    for (const name of GIT_TOOLS) expect(grantsIsolatedWriterGitTool(ctx, name), name).toBe(true);
    // Forma vista pelo PreToolUse da família Claude.
    expect(grantsIsolatedWriterGitTool(ctx, 'mcp__nexus__nexus_git_commit')).toBe(true);
    for (const name of DENIED_GIT_TOOLS) expect(grantsIsolatedWriterGitTool(ctx, name), name).toBe(false);
    expect(grantsIsolatedWriterGitTool(ctx, 'nexus_file_write')).toBe(false);
    expect(grantsIsolatedWriterGitTool(ctx, 'nexus_terminal_run')).toBe(false);
  });

  it('nunca concede fora do writer isolado: mesmo checkout, read-only, aba compartilhada, orquestrador', () => {
    expect(grantsIsolatedWriterGitTool(worker({ executionScope: coordination }), 'nexus_git_commit')).toBe(false);
    expect(grantsIsolatedWriterGitTool(worker({ readOnly: true }), 'nexus_git_status')).toBe(false);
    expect(grantsIsolatedWriterGitTool(worker({ sharedTabWorktree: true }), 'nexus_git_commit')).toBe(false);
    resetGateForTests();
    const orchestrator = mintToken({
      label: 'Maestro', role: 'orchestrator', missionId: 'mission-a',
      scope: coordination, executionScope: worktree, allowedTools: null,
    });
    expect(grantsIsolatedWriterGitTool(orchestrator, 'nexus_git_commit')).toBe(false);
    // Mão do operador SEM a marca do Main de writer isolado.
    resetGateForTests();
    const operator = mintToken({ label: 'op', role: 'user', scope: coordination, executionScope: worktree });
    expect(grantsIsolatedWriterGitTool(operator, 'nexus_git_commit')).toBe(false);
    resetGateForTests();
    const operatorWriter = mintToken({
      label: 'op', role: 'user', scope: coordination, executionScope: worktree, isolatedWriter: true, allowedTools: [],
    });
    expect(grantsIsolatedWriterGitTool(operatorWriter, 'nexus_git_commit')).toBe(true);
  });

  it('tools/list mostra o Git da worktree ao writer isolado e esconde push/pull', async () => {
    const names = await listed(worker());
    for (const name of GIT_TOOLS) expect(names).toContain(name);
    for (const name of DENIED_GIT_TOOLS) expect(names).not.toContain(name);
    expect(names).not.toContain('nexus_file_write');
    expect(names).toContain('nexus_handoff_submit');
  });

  it('tools/list do worker no checkout de coordenação continua sem Git (allowlist vazia)', async () => {
    const names = await listed(worker({ executionScope: coordination }));
    for (const name of GIT_TOOLS) expect(names).not.toContain(name);
  });

  it('nexus_tool_pick enxerga o mesmo conjunto do tools/list', () => {
    const visible = visibleToolsFor(worker(), registry.tools).map((entry) => entry.name);
    expect(visible).toEqual(expect.arrayContaining(GIT_TOOLS));
    expect(visible).not.toContain('nexus_git_push');
  });
});
