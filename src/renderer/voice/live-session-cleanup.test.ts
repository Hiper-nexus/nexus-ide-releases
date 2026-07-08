import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');

describe('live session cleanup', () => {
  it('clears Jarvis MCP grants when a live turn ends', () => {
    const start = source.indexOf('function liveEndTurn()');
    const end = source.indexOf('function liveContextText()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    expect(block).toContain('.finally(() =>');
    expect(block).toContain('clearJarvisMcpSession');
  });
});
