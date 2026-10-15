import { loadToolset } from '../orch/toolset-loader';

/** Catálogo compacto de tools MCP para o prompt do cérebro Jarvis. */
export async function jarvisToolCatalogCompact(): Promise<string> {
  const tools = await loadToolset();
  return tools.map((t) => t.name).join(', ');
}
