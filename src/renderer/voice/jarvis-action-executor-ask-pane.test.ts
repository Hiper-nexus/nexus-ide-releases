import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ask_pane safety path', () => {
  it('routes model-authored pane writes through confirmed/audited MCP', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'jarvis-action-executor.ts'),
      'utf8',
    );
    const branch = source.slice(source.indexOf("action.type === 'ask_pane'"));
    expect(branch).toContain("tool: 'nexus_pane_write'");
    expect(branch).toContain('executeViaMcp(');
    expect(branch).not.toContain('writeToPane(');
  });
});
