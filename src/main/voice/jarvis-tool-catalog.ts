import { buildToolset } from '../orch/tools';

/** Catálogo compacto de tools MCP para o prompt do cérebro Jarvis. */
export function jarvisToolCatalogCompact(): string {
  return buildToolset().map((t) => t.name).join(', ');
}
