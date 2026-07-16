/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/agents-md.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider AGENTS.md standalone — prioridade 10.
 * Adaptação NexusIDE: sem walk-up de ancestrais — só o AGENTS.md da raiz do
 * workspace (a varredura da v1 nunca sai de workspaceRoot + home).
 */
import path from 'node:path';
import {
  emptyProviderResult,
  type DiscoveryContext,
  type ProviderResult,
} from './types';

const SOURCE = 'agents-md' as const;

export function loadAgentsMd(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();

  const agentsMd = path.join(ctx.workspaceRoot, 'AGENTS.md');
  if (ctx.io.fileExists(agentsMd)) {
    result.contextFiles.push({
      source: SOURCE,
      level: 'project',
      path: agentsMd,
      name: 'AGENTS.md',
      kind: 'context',
    });
  }

  return result;
}
