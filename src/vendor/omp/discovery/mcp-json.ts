/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/mcp-json.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider mcp.json standalone — prioridade 5 (fallback compartilhado).
 * Cobre mcp.json / .mcp.json na raiz do projeto (formato Claude Desktop),
 * com expansão de env vars. O logger do omp vira warnings de string — chaves
 * e caminhos apenas, nunca valores.
 */
import path from 'node:path';
import { expandEnvVarsDeep, parseMcpServersRecord, tryParseJson } from './helpers';
import {
  emptyProviderResult,
  type DiscoveryContext,
  type ProviderResult,
} from './types';

const SOURCE = 'mcp-json' as const;

export function loadMcpJson(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();

  for (const filename of ['mcp.json', '.mcp.json']) {
    const filePath = path.join(ctx.workspaceRoot, filename);
    const content = ctx.io.readTextFile(filePath);
    if (content === null) continue;
    const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(
      content,
    );
    if (!json) {
      result.warnings.push(`JSON inválido em ${filePath}`);
      continue;
    }
    if (!json.mcpServers) continue;
    result.mcpServers.push(
      ...parseMcpServersRecord(expandEnvVarsDeep(json.mcpServers, ctx.env), {
        source: SOURCE,
        level: 'project',
        path: filePath,
      }),
    );
  }

  return result;
}
