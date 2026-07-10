import { describe, expect, it } from 'vitest';
import type { McpToolDef } from '../../orch/mcp-protocol';
import { createNexusRealtimeTools } from './nexus-realtime-tools';
import { createGeminiRealtimeTools, toGeminiSchema } from './gemini-realtime-tools';
import { buildToolset } from '../../orch/tools';

const tool = (name: string, inputSchema: Record<string, unknown>): McpToolDef => ({
  name,
  description: `${name} description`,
  inputSchema,
  handler: async () => ({}),
});

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

  it('declares coarse voice, audited UI action, and exact MCP tools once', () => {
    const declarations = createGeminiRealtimeTools(
      [
        tool('nexus_file_read', {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        }),
        tool('nexus_pane_read', { type: 'object', properties: {} }),
      ],
      createNexusRealtimeTools(),
    );
    const names = declarations.map((item) => item.name);

    expect(names).toContain('consultar');
    expect(names).toContain('nexus_action');
    expect(names).toContain('nexus_file_read');
    expect(names).toContain('nexus_pane_read');
    expect(new Set(names).size).toBe(names.length);
    expect(
      declarations.find((item) => item.name === 'nexus_file_read')?.parameters,
    ).toMatchObject({
      type: 'OBJECT',
      properties: { path: { type: 'STRING' } },
      required: ['path'],
    });
  });

  it('converts the complete runtime Nexus MCP catalog without dropping tools', () => {
    const catalog = buildToolset();
    const declarations = createGeminiRealtimeTools(catalog, createNexusRealtimeTools());
    const names = new Set(declarations.map((item) => item.name));

    expect(catalog.length).toBeGreaterThan(60);
    expect(catalog.every((tool) => names.has(tool.name))).toBe(true);
    expect(names).toContain('nexus_ui_read');
    expect(names).toContain('nexus_browser_read');
    expect(names).toContain('nexus_image_generate');
    expect(names.size).toBe(declarations.length);
  });
});
