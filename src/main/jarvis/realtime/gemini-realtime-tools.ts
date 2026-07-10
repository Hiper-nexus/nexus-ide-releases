import type { McpToolDef } from '../../orch/mcp-protocol';
import type { RealtimeToolDefinition } from './provider';
import {
  COARSE_VOICE_TOOLS,
  type GeminiFunctionDeclaration,
} from './coarse-voice-tools';

const GEMINI_SCHEMA_TYPES: Record<string, string> = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
};

/** Convert JSON Schema into the subset accepted by Gemini function calling. */
export function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // Gemini derives object openness itself; boolean additionalProperties is
    // rejected by some Live API revisions.
    if (key === 'additionalProperties' || key === '$schema') continue;
    if (key === 'type' && typeof item === 'string') {
      output.type = GEMINI_SCHEMA_TYPES[item.toLowerCase()] ?? item.toUpperCase();
      continue;
    }
    output[key] = toGeminiSchema(item);
  }
  return output;
}

function fromMcpTool(tool: McpToolDef): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.inputSchema) as GeminiFunctionDeclaration['parameters'],
  };
}

function fromRealtimeTool(tool: RealtimeToolDefinition): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters) as GeminiFunctionDeclaration['parameters'],
  };
}

/**
 * Gemini receives exact schemas for every Nexus MCP capability plus the
 * umbrella UI action and the fast conversational coarse tools.
 */
export function createGeminiRealtimeTools(
  mcpTools: readonly McpToolDef[],
  realtimeTools: readonly RealtimeToolDefinition[],
): GeminiFunctionDeclaration[] {
  const declarations = [
    ...COARSE_VOICE_TOOLS,
    ...realtimeTools.map(fromRealtimeTool),
    ...mcpTools.map(fromMcpTool),
  ];
  const unique = new Map<string, GeminiFunctionDeclaration>();
  for (const declaration of declarations) {
    if (!unique.has(declaration.name)) unique.set(declaration.name, declaration);
  }
  return [...unique.values()];
}
