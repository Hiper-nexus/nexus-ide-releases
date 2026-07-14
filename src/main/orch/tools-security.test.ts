import { describe, expect, it } from 'vitest';
import { buildSecurityTools } from './tools-security';

describe('BridgeMind security tools', () => {
  it('publishes only read-only audit tools with bounded schemas', () => {
    const tools = buildSecurityTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'nexus_content_audit',
      'nexus_security_audit',
    ]);
    expect(tools.every((tool) => tool.requiresConfirm !== true)).toBe(true);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });
});
