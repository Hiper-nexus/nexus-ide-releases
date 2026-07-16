/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/capability/index.ts
 * (registry + dedup) e packages/coding-agent/src/discovery/index.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Adaptação NexusIDE: o registry dinâmico de capabilities/providers vira uma
 * lista estática ordenada por prioridade. Dedup first-wins (provider de maior
 * prioridade sombreia o de menor), com as mesmas chaves do omp:
 *   - MCP servers: name          - skills: name
 *   - commands: name             - context files: caminho absoluto resolvido
 */
import path from 'node:path';
import { loadAgentsMd } from './agents-md';
import { loadClaude } from './claude';
import { loadCline } from './cline';
import { loadCodex } from './codex';
import { loadCopilot } from './copilot';
import { loadCursor } from './cursor';
import { loadGemini } from './gemini';
import { loadMcpJson } from './mcp-json';
import {
  DISCOVERY_SOURCE_PRIORITY,
  emptyProviderResult,
  type DiscoveryContext,
  type DiscoverySource,
  type ProviderResult,
} from './types';

export type { FsFingerprint } from './fs-probe';
export { FsProbe, fingerprintStillValid } from './fs-probe';
export * from './types';

interface ProviderEntry {
  source: DiscoverySource;
  priority: number;
  load(ctx: DiscoveryContext): ProviderResult;
}

/**
 * Providers portados na v1, já em ordem de prioridade (maior primeiro).
 * opencode (55) / windsurf (50) / vscode (20) ficam para a próxima onda —
 * ver DISCOVERY_SOURCE_PRIORITY em types.ts.
 */
export const DISCOVERY_PROVIDERS: readonly ProviderEntry[] = [
  { source: 'claude', priority: DISCOVERY_SOURCE_PRIORITY.claude, load: loadClaude },
  { source: 'codex', priority: DISCOVERY_SOURCE_PRIORITY.codex, load: loadCodex },
  { source: 'gemini', priority: DISCOVERY_SOURCE_PRIORITY.gemini, load: loadGemini },
  { source: 'cursor', priority: DISCOVERY_SOURCE_PRIORITY.cursor, load: loadCursor },
  { source: 'cline', priority: DISCOVERY_SOURCE_PRIORITY.cline, load: loadCline },
  { source: 'copilot', priority: DISCOVERY_SOURCE_PRIORITY.copilot, load: loadCopilot },
  { source: 'agents-md', priority: DISCOVERY_SOURCE_PRIORITY['agents-md'], load: loadAgentsMd },
  { source: 'mcp-json', priority: DISCOVERY_SOURCE_PRIORITY['mcp-json'], load: loadMcpJson },
];

/** Dedup first-wins por chave (loadImpl do omp, sem _shadowed). */
function dedupeByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Roda todos os providers em ordem de prioridade e agrega com dedup.
 * Fail-soft: exceção em um provider vira warning e não derruba os demais.
 */
export function discoverConfigs(ctx: DiscoveryContext): ProviderResult {
  const merged = emptyProviderResult();

  const ordered = [...DISCOVERY_PROVIDERS].sort(
    (a, b) => b.priority - a.priority,
  );
  for (const provider of ordered) {
    let result: ProviderResult;
    try {
      result = provider.load(ctx);
    } catch (error) {
      merged.warnings.push(
        `[${provider.source}] falha ao carregar: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    merged.mcpServers.push(...result.mcpServers);
    merged.contextFiles.push(...result.contextFiles);
    merged.skills.push(...result.skills);
    merged.commands.push(...result.commands);
    merged.warnings.push(
      ...result.warnings.map((w) => `[${provider.source}] ${w}`),
    );
  }

  return {
    // MCP homônimo: provider de maior prioridade vence (ex.: claude > cursor).
    mcpServers: dedupeByKey(merged.mcpServers, (s) => s.name),
    // Context files: mesmo arquivo descoberto por dois providers → atribuição
    // fica com o de maior prioridade.
    contextFiles: dedupeByKey(merged.contextFiles, (f) => path.resolve(f.path)),
    skills: dedupeByKey(merged.skills, (s) => s.name),
    commands: dedupeByKey(merged.commands, (c) => c.name),
    warnings: merged.warnings,
  };
}
