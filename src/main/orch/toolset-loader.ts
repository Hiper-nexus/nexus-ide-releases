import type { McpToolDef } from './mcp-protocol';

let pending: Promise<McpToolDef[]> | null = null;

/**
 * O grafo de `tools.ts` (~2 MB no bundle) não entra no parse inicial do main.
 * A primeira chamada (start do MCP, catálogo, voz) carrega uma vez.
 */
export function loadToolset(): Promise<McpToolDef[]> {
  pending ??= import('./tools').then((mod) => mod.buildToolset());
  return pending;
}
