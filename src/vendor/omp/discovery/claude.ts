/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/claude.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider Claude Code — prioridade 80.
 * Adaptação NexusIDE (escopo v1): MCP servers, context files (CLAUDE.md),
 * skills e slash commands. Hooks/tools/settings/system-prompt/extensions do
 * omp ficam fora. Skills de projeto não sobem ancestrais além do workspace.
 */
import path from 'node:path';
import {
  expandEnvVarsDeep,
  parseMcpServersRecord,
  scanCommandsFromDir,
  scanSkillsFromDir,
  tryParseJson,
} from './helpers';
import {
  emptyProviderResult,
  type DiscoveredMcpServer,
  type DiscoveryContext,
  type DiscoveryLevel,
  type ProviderResult,
} from './types';

const SOURCE = 'claude' as const;
const CONFIG_DIR = '.claude';

/**
 * MCP servers: por nível, o primeiro arquivo que declarar servers vence
 * (paridade omp). Nível user: ~/.claude.json (com expansão de env — missão
 * B4 §2) e ~/.claude/mcp.json. Nível project: .claude/.mcp.json e
 * .claude/mcp.json (o .mcp.json da raiz do workspace é do provider mcp-json).
 */
function loadMcpServers(ctx: DiscoveryContext): {
  items: DiscoveredMcpServer[];
  warnings: string[];
} {
  const items: DiscoveredMcpServer[] = [];
  const warnings: string[] = [];

  const byLevel: Array<{ level: DiscoveryLevel; candidates: string[] }> = [
    {
      level: 'user',
      candidates: [
        path.join(ctx.home, '.claude.json'),
        path.join(ctx.home, CONFIG_DIR, 'mcp.json'),
      ],
    },
    {
      level: 'project',
      candidates: [
        path.join(ctx.workspaceRoot, CONFIG_DIR, '.mcp.json'),
        path.join(ctx.workspaceRoot, CONFIG_DIR, 'mcp.json'),
      ],
    },
  ];

  for (const { level, candidates } of byLevel) {
    for (const filePath of candidates) {
      const content = ctx.io.readTextFile(filePath);
      if (content === null) continue;
      const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(
        content,
      );
      if (!json) {
        warnings.push(`JSON inválido em ${filePath}`);
        continue;
      }
      if (!json.mcpServers) continue;
      // Expansão de ${VAR}/${VAR:-default} preservada do omp. Os valores
      // resultantes podem ser segredos — nunca logar.
      const servers = parseMcpServersRecord(
        expandEnvVarsDeep(json.mcpServers, ctx.env),
        { source: SOURCE, level, path: filePath },
      );
      if (servers.length > 0) {
        items.push(...servers);
        break; // primeiro arquivo com servers vence neste nível
      }
    }
  }

  return { items, warnings };
}

export function loadClaude(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();
  const userBase = path.join(ctx.home, CONFIG_DIR);
  const projectBase = path.join(ctx.workspaceRoot, CONFIG_DIR);

  // ── MCP servers ───────────────────────────────────────────────────────────
  const mcp = loadMcpServers(ctx);
  result.mcpServers.push(...mcp.items);
  result.warnings.push(...mcp.warnings);

  // ── Context files (CLAUDE.md) ─────────────────────────────────────────────
  const contextCandidates: Array<{ filePath: string; level: DiscoveryLevel }> =
    [
      { filePath: path.join(userBase, 'CLAUDE.md'), level: 'user' },
      // Adaptação Nexus: o omp só lê .claude/CLAUDE.md, mas a convenção
      // dominante do Claude Code é o CLAUDE.md na raiz do repositório.
      { filePath: path.join(ctx.workspaceRoot, 'CLAUDE.md'), level: 'project' },
      { filePath: path.join(projectBase, 'CLAUDE.md'), level: 'project' },
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

  // ── Skills (.claude/skills/*/SKILL.md) ────────────────────────────────────
  for (const { dir, level } of [
    { dir: path.join(userBase, 'skills'), level: 'user' as const },
    { dir: path.join(projectBase, 'skills'), level: 'project' as const },
  ]) {
    const scanned = scanSkillsFromDir(ctx.io, dir, { source: SOURCE, level });
    result.skills.push(...scanned.skills);
    result.warnings.push(...scanned.warnings);
  }

  // ── Slash commands (.claude/commands/**/*.md, recursivo) ─────────────────
  for (const { dir, level } of [
    { dir: path.join(userBase, 'commands'), level: 'user' as const },
    { dir: path.join(projectBase, 'commands'), level: 'project' as const },
  ]) {
    result.commands.push(
      ...scanCommandsFromDir(
        ctx.io,
        dir,
        { source: SOURCE, level },
        { recursive: true },
      ),
    );
  }

  return result;
}
