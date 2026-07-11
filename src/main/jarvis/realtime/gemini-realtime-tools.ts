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

function fromRealtimeTool(tool: RealtimeToolDefinition): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters) as GeminiFunctionDeclaration['parameters'],
  };
}

/**
 * Keep the Live tool surface intentionally small. The audited `nexus_action`
 * umbrella still reaches Nexus MCP operations, while avoiding dozens of
 * overlapping declarations that make short spoken commands ambiguous.
 */
export function createGeminiRealtimeTools(
  realtimeTools: readonly RealtimeToolDefinition[],
): GeminiFunctionDeclaration[] {
  const declarations = [
    ...COARSE_VOICE_TOOLS,
    ...realtimeTools.map(fromRealtimeTool),
  ];
  const unique = new Map<string, GeminiFunctionDeclaration>();
  for (const declaration of declarations) {
    if (!unique.has(declaration.name)) unique.set(declaration.name, declaration);
  }
  return [...unique.values()];
}
