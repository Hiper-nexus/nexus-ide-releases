/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/gemini.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider Gemini CLI — prioridade 60.
 * Adaptação NexusIDE (escopo v1): MCP servers de settings.json e context
 * files GEMINI.md. Extensions/system-prompt/settings do omp ficam fora.
 */
import path from 'node:path';
import { expandEnvVarsDeep, parseMcpServersRecord, tryParseJson } from './helpers';
import {
  emptyProviderResult,
  type DiscoveryContext,
  type DiscoveryLevel,
  type ProviderResult,
} from './types';

const SOURCE = 'gemini' as const;
const CONFIG_DIR = '.gemini';

export function loadGemini(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();
  const userBase = path.join(ctx.home, CONFIG_DIR);
  const projectBase = path.join(ctx.workspaceRoot, CONFIG_DIR);

  // ── MCP servers (settings.json → mcpServers) ─────────────────────────────
  for (const { filePath, level } of [
    { filePath: path.join(userBase, 'settings.json'), level: 'user' as const },
    {
      filePath: path.join(projectBase, 'settings.json'),
      level: 'project' as const,
    },
  ]) {
    const content = ctx.io.readTextFile(filePath);
    if (content === null) continue;
    const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(
      content,
    );
    if (!json) {
      result.warnings.push(`JSON inválido em ${filePath}`);
      continue;
    }
    if (!json.mcpServers || typeof json.mcpServers !== 'object') continue;
    result.mcpServers.push(
      ...parseMcpServersRecord(expandEnvVarsDeep(json.mcpServers, ctx.env), {
        source: SOURCE,
        level,
        path: filePath,
      }),
    );
  }

  // ── Context files (GEMINI.md) ─────────────────────────────────────────────
  const contextCandidates: Array<{ filePath: string; level: DiscoveryLevel }> =
    [
      { filePath: path.join(userBase, 'GEMINI.md'), level: 'user' },
      // Adaptação Nexus: o Gemini CLI também lê GEMINI.md na raiz do projeto
      // (contextFileName default); o omp cobre só o .gemini/GEMINI.md.
      { filePath: path.join(ctx.workspaceRoot, 'GEMINI.md'), level: 'project' },
      { filePath: path.join(projectBase, 'GEMINI.md'), level: 'project' },
    ];
  for (const { filePath, level } of contextCandidates) {
    if (!ctx.io.fileExists(filePath)) continue;
    result.contextFiles.push({
      source: SOURCE,
      level,
      path: filePath,
      name: path.basename(filePath),
      kind: 'context',
    });
  }

  return result;
}
