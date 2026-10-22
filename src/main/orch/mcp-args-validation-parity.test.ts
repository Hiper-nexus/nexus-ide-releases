import { describe, expect, it } from 'vitest';
import { buildToolset } from './tools';
import { validatedToolArgKeys } from './mcp-args-validation';

/**
 * Every property a tool advertises in its JSON inputSchema must be accepted by
 * the strict zod validator that runs before the handler. A mismatch means the
 * model is told it may send a field that the dispatcher then refuses — the
 * call fails with an opaque "unrecognized key" for an argument we documented.
 */
describe('advertised inputSchema × zod validator parity', () => {
  const tools = buildToolset();

  it('covers the tools that have a strict validator', () => {
    const validated = tools.filter((tool) => validatedToolArgKeys(tool.name));
    expect(validated.length).toBeGreaterThan(20);
  });

  it.each(
    tools
      .filter((tool) => validatedToolArgKeys(tool.name))
      .map((tool) => [tool.name, tool] as const),
  )('%s accepts every advertised property', (_name, tool) => {
    const accepted = new Set(validatedToolArgKeys(tool.name));
    const properties = Object.keys(
      ((tool.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {},
    );
    const refused = properties.filter((key) => !accepted.has(key));
    expect(refused).toEqual([]);
  });
});
