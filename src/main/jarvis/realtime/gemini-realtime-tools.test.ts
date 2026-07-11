import { describe, expect, it } from 'vitest';
import { createNexusRealtimeTools } from './nexus-realtime-tools';
import { createGeminiRealtimeTools, toGeminiSchema } from './gemini-realtime-tools';
import { buildToolset } from '../../orch/tools';

describe('Gemini realtime tool declarations', () => {
  it('converts nested JSON Schema types to the Gemini Live contract', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          range: {
            type: 'array',
            items: { type: 'integer' },
          },
        },
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING' },
        range: { type: 'ARRAY', items: { type: 'INTEGER' } },
      },
    });
  });

  it('declares only coarse voice tools and the audited umbrella action', () => {
    const declarations = createGeminiRealtimeTools(createNexusRealtimeTools());
    const names = declarations.map((item) => item.name);

    expect(names).toContain('consultar');
    expect(names).toContain('nexus_action');
    expect(names).not.toContain('nexus_file_read');
    expect(names).not.toContain('nexus_pane_read');
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the Live setup bounded instead of exposing the entire MCP catalog', () => {
    const catalog = buildToolset();
    const declarations = createGeminiRealtimeTools(createNexusRealtimeTools());
    const names = new Set(declarations.map((item) => item.name));

    expect(catalog.length).toBeGreaterThan(60);
    expect(catalog.every((tool) => !names.has(tool.name))).toBe(true);
    expect(names.size).toBeLessThanOrEqual(12);
    expect(names.size).toBe(declarations.length);
  });
});
