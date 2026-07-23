import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildEditorTools } from '../tools-editor';
import { buildFileTools } from '../tools-files';
import { resetHashlineSessions } from '../../editor/hashline-session';
import { testProjectScope } from './scope-fixture';

const workspace = vi.hoisted(() => ({ current: '' }));
vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-editor');
const wsDir = path.join(testDir, 'workspace');

describe('tools-editor', () => {
  beforeAll(() => {
    workspace.current = wsDir;
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsDir, 'app.ts'),
      'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      'utf-8',
    );
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('nexus_editor_focus returns file content', async () => {
    const tools = buildEditorTools();
    const focus = tools.find((t) => t.name === 'nexus_editor_focus')!;
    const result = await focus.handler({ path: 'app.ts' }, fakeCtx());
    expect(result).toHaveProperty('content', 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
    expect(result).toHaveProperty('lines', 3);
    expect(result).toHaveProperty('path', 'app.ts');
  });

  it('nexus_editor_focus with line', async () => {
    const tools = buildEditorTools();
    const focus = tools.find((t) => t.name === 'nexus_editor_focus')!;
    const result = await focus.handler({ path: 'app.ts', line: 2 }, fakeCtx()) as { line: number };
    expect(result.line).toBe(2);
  });

  it('nexus_editor_focus rejects a workspace-internal symbolic link', async () => {
    const target = path.join(wsDir, 'focus-target.ts');
    const link = path.join(wsDir, 'focus-link.ts');
    fs.writeFileSync(target, 'export const safe = true;\n');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link, 'file');
    const focus = buildEditorTools().find((tool) => tool.name === 'nexus_editor_focus')!;

    await expect(focus.handler({ path: 'focus-link.ts' }, fakeCtx())).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it('nexus_editor_insert inserts text at line', async () => {
    const tools = buildEditorTools();
    const insert = tools.find((t) => t.name === 'nexus_editor_insert')!;
    const result = await insert.handler(
      { path: 'app.ts', text: '// comment\n', line: 2 },
      fakeCtx(),
    );
    expect(result).toHaveProperty('inserted', 11);
    const content = fs.readFileSync(path.join(wsDir, 'app.ts'), 'utf-8');
    expect(content).toContain('// comment');
  });

  it('nexus_editor_replace_selection replaces text', async () => {
    // Reset file
    fs.writeFileSync(
      path.join(wsDir, 'app.ts'),
      'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      'utf-8',
    );
    const tools = buildEditorTools();
    const replace = tools.find((t) => t.name === 'nexus_editor_replace_selection')!;
    const result = await replace.handler(
      { path: 'app.ts', oldText: 'const x = 1;', newText: 'const x = 42;' },
      fakeCtx(),
    );
    expect(result).toHaveProperty('replaced', 1);
    const content = fs.readFileSync(path.join(wsDir, 'app.ts'), 'utf-8');
    expect(content).toContain('const x = 42;');
  });

  it('nexus_editor_insert rejects mutable hardlinks without changing the external inode', async () => {
    const outside = path.join(testDir, 'outside-editor.ts');
    const linked = path.join(wsDir, 'linked-editor.ts');
    fs.writeFileSync(outside, 'export const outside = true;\n');
    fs.rmSync(linked, { force: true });
    fs.linkSync(outside, linked);
    const insert = buildEditorTools().find((tool) => tool.name === 'nexus_editor_insert')!;

    await expect(
      insert.handler({ path: 'linked-editor.ts', text: '// injected\n', line: 1 }, fakeCtx()),
    ).rejects.toThrow(/hardlink/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('export const outside = true;\n');
  });

  it('nexus_editor_goto_line returns line content', async () => {
    const tools = buildEditorTools();
    const goto = tools.find((t) => t.name === 'nexus_editor_goto_line')!;
    const result = await goto.handler({ path: 'app.ts', line: 3 }, fakeCtx());
    expect(result).toHaveProperty('lineContent', 'const z = 3;');
    expect(result).toHaveProperty('totalLines', 3);
  });
});

describe('nexus_editor_apply_patch (hashline patch bus)', () => {
  const applyTool = () =>
    buildEditorTools().find((t) => t.name === 'nexus_editor_apply_patch')!;
  const readTool = () =>
    buildFileTools().find((t) => t.name === 'nexus_file_read')!;

  beforeAll(() => {
    workspace.current = wsDir;
    fs.mkdirSync(wsDir, { recursive: true });
  });

  beforeEach(() => {
    resetHashlineSessions();
    fs.writeFileSync(
      path.join(wsDir, 'patch-me.ts'),
      'alpha\nbeta\ngamma\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(wsDir, 'other.ts'), 'one\ntwo\n', 'utf-8');
  });

  it('nexus_file_read hashline mode mints a [path#TAG] header with numbered lines', async () => {
    const result = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string; tag: string; content: string; totalLines: number };
    expect(result.tag).toMatch(/^[0-9A-F]{4}$/);
    expect(result.header).toBe(`[patch-me.ts#${result.tag}]`);
    expect(result.content.split('\n')[0]).toBe(result.header);
    expect(result.content).toContain('1:alpha');
    expect(result.content).toContain('3:gamma');
    expect(result.totalLines).toBe(4);
  });

  it('applies a read-then-patch round trip through the workspace primitives', async () => {
    const read = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };
    const patch = `${read.header}\nSWAP 2.=2:\n+BETA`;

    const result = (await applyTool().handler({ patch }, fakeCtx())) as {
      files: number;
      applied: Array<{ path: string; op: string; edits: number; header: string }>;
      summary: string;
    };

    expect(result.files).toBe(1);
    expect(result.applied[0].path).toBe('patch-me.ts');
    expect(result.applied[0].op).toBe('update');
    expect(result.applied[0].edits).toBeGreaterThan(0);
    expect(result.applied[0].header).toMatch(/^\[patch-me\.ts#[0-9A-F]{4}\]$/);
    expect(result.summary).toContain('patch-me.ts');
    expect(fs.readFileSync(path.join(wsDir, 'patch-me.ts'), 'utf-8')).toBe(
      'alpha\nBETA\ngamma\n',
    );
  });

  it('revokes after prepare and performs zero filesystem writes', async () => {
    const read = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };
    let authorityChecks = 0;

    await expect(
      applyTool().handler(
        { patch: `${read.header}\nSWAP 2.=2:\n+BETA` },
        fakeCtx(),
        {
          assertCurrentAuthority: () => {
            authorityChecks += 1;
            // First check is the handler boundary. The second is Patcher.commit,
            // after parsing/read/tag validation and immediately before writeText.
            if (authorityChecks === 2) {
              throw new Error('session_authority_revoked');
            }
          },
        },
      ),
    ).rejects.toThrow('session_authority_revoked');

    expect(authorityChecks).toBe(2);
    expect(fs.readFileSync(path.join(wsDir, 'patch-me.ts'), 'utf-8')).toBe(
      'alpha\nbeta\ngamma\n',
    );
  });

  it('rejects a stale tag with the mismatch context and leaves the file untouched', async () => {
    const read = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };
    // External drift after the read (rewrites the anchored line).
    fs.writeFileSync(
      path.join(wsDir, 'patch-me.ts'),
      'alpha\nCHANGED\ngamma\ndelta\n',
      'utf-8',
    );

    await expect(
      applyTool().handler({ patch: `${read.header}\nSWAP 2.=2:\n+BETA` }, fakeCtx()),
    ).rejects.toThrow(/file changed between read and edit/);
    expect(fs.readFileSync(path.join(wsDir, 'patch-me.ts'), 'utf-8')).toBe(
      'alpha\nCHANGED\ngamma\ndelta\n',
    );
  });

  it('applies multi-file patches all-or-nothing: one bad section aborts every write', async () => {
    const readA = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };
    const patch = [
      readA.header,
      'SWAP 1.=1:',
      '+ALPHA',
      // Second section carries a fabricated tag: prepare must fail before ANY write.
      '[other.ts#0000]',
      'SWAP 1.=1:',
      '+ONE',
    ].join('\n');

    await expect(applyTool().handler({ patch }, fakeCtx())).rejects.toThrow(
      /Edit rejected/,
    );
    expect(fs.readFileSync(path.join(wsDir, 'patch-me.ts'), 'utf-8')).toBe(
      'alpha\nbeta\ngamma\n',
    );
    expect(fs.readFileSync(path.join(wsDir, 'other.ts'), 'utf-8')).toBe(
      'one\ntwo\n',
    );
  });

  it('applies a valid multi-file patch and reports one section per file', async () => {
    const readA = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };
    const readB = (await readTool().handler(
      { path: 'other.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };
    const patch = [
      readA.header,
      'SWAP 1.=1:',
      '+ALPHA',
      readB.header,
      'INS.TAIL:',
      '+three',
    ].join('\n');

    const result = (await applyTool().handler({ patch }, fakeCtx())) as {
      files: number;
      applied: Array<{ path: string }>;
    };

    expect(result.files).toBe(2);
    expect(result.applied.map((s) => s.path).sort()).toEqual([
      'other.ts',
      'patch-me.ts',
    ]);
    expect(fs.readFileSync(path.join(wsDir, 'patch-me.ts'), 'utf-8')).toBe(
      'ALPHA\nbeta\ngamma\n',
    );
    expect(fs.readFileSync(path.join(wsDir, 'other.ts'), 'utf-8')).toBe(
      'one\ntwo\nthree\n',
    );
  });

  it('rejects edits anchored on lines the hashline read never displayed', async () => {
    const read = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true, offset: 1, limit: 1 },
      fakeCtx(),
    )) as { header: string; lines: number };
    expect(read.lines).toBe(1);

    await expect(
      applyTool().handler({ patch: `${read.header}\nSWAP 3.=3:\n+GAMMA` }, fakeCtx()),
    ).rejects.toThrow(/never displayed/);
  });

  it('keeps session snapshot stores isolated by gate token', async () => {
    const read = (await readTool().handler(
      { path: 'patch-me.ts', hashline: true },
      fakeCtx(),
    )) as { header: string };

    // Another session did not mint this tag; content hash still matches the
    // live file, so the patch applies on hash identity (tags are content-derived).
    const otherCtx = { ...fakeCtx(), token: 'other-session' };
    const result = (await applyTool().handler(
      { patch: `${read.header}\nSWAP 2.=2:\n+BETA` },
      otherCtx,
    )) as { applied: Array<{ op: string }> };
    expect(result.applied[0].op).toBe('update');
  });

  it('rejects a patch without any [path#TAG] section', async () => {
    await expect(
      applyTool().handler({ patch: 'SWAP 1.=1:\n+X' }, fakeCtx()),
    ).rejects.toThrow(/must begin with/);
  });
});

function fakeCtx() {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null as string[] | null,
    allowedSkills: null as string[] | null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: testProjectScope({ rootRealPath: fs.realpathSync(wsDir) }),
  };
}
