import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildEditorTools } from '../tools-editor';
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
