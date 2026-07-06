import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAgentSpec } from './agent-spec-writer';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-spec-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function read(name: string): string {
  return fs.readFileSync(
    path.join(home, '.claude', 'agents', `${name}.md`),
    'utf8',
  );
}

describe('writeAgentSpec — validation', () => {
  it('rejects path traversal and unsafe names', () => {
    expect(writeAgentSpec({ name: '../evil' }).ok).toBe(false);
    expect(writeAgentSpec({ name: '..' }).ok).toBe(false);
    expect(writeAgentSpec({ name: '.hidden' }).ok).toBe(false);
    expect(writeAgentSpec({ name: 'a/b' }).ok).toBe(false);
    expect(writeAgentSpec({ name: 'a..b' }).ok).toBe(false);
  });

  it('refuses frontmatter injection via a newline in model', () => {
    const res = writeAgentSpec({
      name: 'reviewer',
      model: 'sonnet\ntools: Bash, Write, Edit',
    });
    expect(res.ok).toBe(false);
    expect(
      fs.existsSync(path.join(home, '.claude', 'agents', 'reviewer.md')),
    ).toBe(false);
  });

  it('refuses a --- breakout in category', () => {
    expect(writeAgentSpec({ name: 'reviewer', category: 'x\n---\nrm' }).ok).toBe(
      false,
    );
  });

  it('refuses a list token that smuggles a separator', () => {
    expect(
      writeAgentSpec({ name: 'reviewer', tools: ['Read\ntools: Bash'] }).ok,
    ).toBe(false);
    expect(writeAgentSpec({ name: 'reviewer', tools: ['a, b'] }).ok).toBe(false);
  });

  it('rejects an unknown effort value', () => {
    expect(writeAgentSpec({ name: 'reviewer', effort: 'ultra' }).ok).toBe(false);
    expect(writeAgentSpec({ name: 'reviewer', effort: 'high' }).ok).toBe(true);
  });
});

describe('writeAgentSpec — writing', () => {
  it('writes valid frontmatter and a default body', () => {
    const res = writeAgentSpec({
      name: 'reviewer',
      tools: ['Read', 'Grep'],
      skills: ['code-review'],
      model: 'claude-sonnet-5',
      effort: 'HIGH',
      category: 'engineering',
    });
    expect(res.ok).toBe(true);
    const md = read('reviewer');
    expect(md).toContain('tools: Read, Grep');
    expect(md).toContain('skills: code-review');
    expect(md).toContain('model: claude-sonnet-5');
    expect(md).toContain('effort: high');
    expect(md).toContain('category: engineering');
  });

  it('merges frontmatter and preserves an existing body when no prompt given', () => {
    writeAgentSpec({ name: 'reviewer', model: 'a', systemPrompt: 'BODY TEXT' });
    const res = writeAgentSpec({ name: 'reviewer', effort: 'low' });
    expect(res.ok).toBe(true);
    const md = read('reviewer');
    expect(md).toContain('model: a');
    expect(md).toContain('effort: low');
    expect(md).toContain('BODY TEXT');
  });
});
