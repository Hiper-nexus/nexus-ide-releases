import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  isToolAllowedForRole,
  type AgentGateContext,
} from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';
import { validateToolArgs } from './mcp-args-validation';
import { buildLspTools } from './tools-lsp';

let parentDir = '';
let root = '';
let scope: ProjectExecutionScope;

function ctx(): AgentGateContext {
  return {
    token: 'lsp-test-token',
    label: 'LSP test',
    role: 'worker',
    scope,
    executionScope: scope,
    readOnly: true,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

beforeEach(() => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lsp-tools-'));
  root = path.join(parentDir, 'project');
  fs.mkdirSync(root);
  root = fs.realpathSync(root);
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const value = 1;\n');
  scope = Object.freeze({
    version: 1,
    installationId: 'install-lsp-tools',
    projectId: 'project-lsp-tools',
    checkoutId: 'checkout-lsp-tools',
    rootRealPath: root,
    identitySource: 'provisional',
  });
});

afterEach(() => {
  fs.rmSync(parentDir, { recursive: true, force: true });
});

describe('buildLspTools', () => {
  it('publishes only the four read-only Nexus LSP operations', () => {
    const tools = buildLspTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'nexus_lsp_symbols',
      'nexus_lsp_definition',
      'nexus_lsp_references',
      'nexus_lsp_diagnostics',
    ]);
    for (const tool of tools) {
      expect(tool.requiresConfirm).not.toBe(true);
      expect(effectPolicyForTool(tool.name)).toBe('read-only');
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
    expect(
      isToolAllowedForRole('worker', ['nexus_lsp_symbols'], 'nexus_lsp_symbols'),
    ).toBe(true);
    // F-1157: a allowlist do worker não nega mais — o LSP fica ao alcance
    // mesmo quando a lista não o nomeia.
    expect(
      isToolAllowedForRole('worker', ['nexus_file_read'], 'nexus_lsp_symbols'),
    ).toBe(true);
  });

  it('rejects traversal, symlink escape and oversized source before worker launch', async () => {
    const symbols = buildLspTools().find(
      (tool) => tool.name === 'nexus_lsp_symbols',
    )!;
    fs.writeFileSync(path.join(parentDir, 'outside.ts'), 'export const secret = 1;\n');
    fs.symlinkSync(path.join(parentDir, 'outside.ts'), path.join(root, 'link.ts'));
    fs.writeFileSync(path.join(root, 'huge.ts'), 'x'.repeat(1_048_577));

    await expect(
      symbols.handler({ path: '../outside.ts' }, ctx()),
    ).rejects.toThrow(/escapes workspace/i);
    await expect(
      symbols.handler({ path: 'link.ts' }, ctx()),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      symbols.handler({ path: 'huge.ts' }, ctx()),
    ).rejects.toThrow(/exceeds/i);
  });

  it('validates positions and DoS budgets in the central MCP argument gate', () => {
    expect(() =>
      validateToolArgs('nexus_lsp_definition', {
        path: 'index.ts',
        line: 0,
        column: 1,
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_lsp_references', {
        path: 'index.ts',
        line: 1,
        column: 1,
        maxResults: 101,
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_lsp_symbols', {
        path: 'index.ts',
        unexpected: true,
      }),
    ).toThrow();
  });
});
