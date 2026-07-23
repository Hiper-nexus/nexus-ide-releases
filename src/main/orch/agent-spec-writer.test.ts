import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAgentSpecWrite, writeAgentSpec } from './agent-spec-writer';

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

  it('accepts future CLI effort values and rejects unsafe syntax', () => {
    expect(writeAgentSpec({ name: 'reviewer', effort: 'ultra' }).ok).toBe(true);
    expect(writeAgentSpec({ name: 'reviewer', effort: 'high\nunsafe' }).ok).toBe(false);
  });
});

describe('writeAgentSpec — writing', () => {
  it('prepara conteúdo integral revisável e aplica CAS contra drift', () => {
    expect(
      writeAgentSpec({
        name: 'reviewer',
        model: 'sonnet',
        systemPrompt: 'Contrato original',
      }).ok,
    ).toBe(true);
    const candidate = prepareAgentSpecWrite({
      name: 'reviewer',
      tools: ['Read', 'Grep'],
      systemPrompt: 'Prompt novo que precisa aparecer integralmente.',
    });
    expect(candidate.nextContents).toContain('tools: Read, Grep');
    expect(candidate.nextContents).toContain(
      'Prompt novo que precisa aparecer integralmente.',
    );

    expect(
      writeAgentSpec({
        name: 'reviewer',
        systemPrompt: 'Mudança concorrente',
      }).ok,
    ).toBe(true);
    const stale = writeAgentSpec(candidate.patch, candidate.currentFingerprint);
    expect(stale).toMatchObject({ ok: false });
    expect(stale.error).toMatch(/changed.*confirmation/i);
    expect(read('reviewer')).toContain('Mudança concorrente');
  });

  it('recusa review truncada, controles invisíveis e arquivo symlink', () => {
    expect(() =>
      prepareAgentSpecWrite({
        name: 'huge',
        systemPrompt: 'x'.repeat(6_100),
      }),
    ).toThrow(/exceeds 6000/i);
    expect(() =>
      prepareAgentSpecWrite({
        name: 'bidi',
        systemPrompt: 'benigno\u202emalicioso',
      }),
    ).toThrow(/invisible control/i);

    const dir = path.join(home, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, 'segredo', 'utf8');
    fs.symlinkSync(outside, path.join(dir, 'linked.md'));
    expect(() => prepareAgentSpecWrite({ name: 'linked', model: 'sonnet' }))
      .toThrow(/regular single-link/i);
  });

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
