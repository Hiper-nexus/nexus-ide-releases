/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/cursor.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider Cursor — prioridade 50.
 * Adaptação NexusIDE (escopo v1): MCP servers de mcp.json e rules
 * (.cursor/rules/*.mdc|md + .cursorrules legado) como context/rule files.
 * Settings do omp ficam fora.
 */
import path from 'node:path';
import { expandEnvVarsDeep, parseMcpServersRecord, tryParseJson } from './helpers';
import {
  emptyProviderResult,
  type DiscoveryContext,
  type ProviderResult,
} from './types';

const SOURCE = 'cursor' as const;
const CONFIG_DIR = '.cursor';

export function loadCursor(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();
  const userBase = path.join(ctx.home, CONFIG_DIR);
  const projectBase = path.join(ctx.workspaceRoot, CONFIG_DIR);

  // ── MCP servers (mcp.json → mcpServers) ──────────────────────────────────
  for (const { filePath, level } of [
    { filePath: path.join(userBase, 'mcp.json'), level: 'user' as const },
    { filePath: path.join(projectBase, 'mcp.json'), level: 'project' as const },
  ]) {
    const content = ctx.io.readTextFile(filePath);
    if (content === null) continue;
    const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(
      content,
    );
    if (!json?.mcpServers) {
      result.warnings.push(`${filePath}: chave 'mcpServers' ausente ou inválida`);
      continue;
    }
    result.mcpServers.push(
      ...parseMcpServersRecord(expandEnvVarsDeep(json.mcpServers, ctx.env), {
        source: SOURCE,
        level,
        path: filePath,
      }),
    );
  }

  // ── Rules (.cursor/rules/*.mdc|md) ───────────────────────────────────────
  for (const { dir, level } of [
    { dir: path.join(userBase, 'rules'), level: 'user' as const },
    { dir: path.join(projectBase, 'rules'), level: 'project' as const },
  ]) {
    for (const filePath of ctx.io.walkFiles(dir, {
      extensions: ['mdc', 'md'],
      recursive: false,
    })) {
      result.contextFiles.push({
        source: SOURCE,
        level,
        path: filePath,
        name: path.basename(filePath),
        kind: 'rule',
      });
    }
  }

  // ── .cursorrules legado (raiz do workspace) ──────────────────────────────
  const legacyRules = path.join(ctx.workspaceRoot, '.cursorrules');
  if (ctx.io.fileExists(legacyRules)) {
    result.contextFiles.push({
      source: SOURCE,
      level: 'project',
      path: legacyRules,
      name: '.cursorrules',
      kind: 'rule',
    });
  }

  return result;
}
