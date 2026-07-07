import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildEditorTools } from '../tools-editor';

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-editor');
const wsDir = path.join(testDir, 'workspace');

describe('tools-editor', () => {
  beforeAll(() => {
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
    const result = await focus.handler({ path: 'app.ts', line: 2 }, fakeCtx());
    expect(result.line).toBe(2);
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
  };
}

// Override activeWorkspaceOrNull for tests
import { activeWorkspaceOrNull } from '../../persistence/workspace-store';
(activeWorkspaceOrNull as unknown as () => string | null) = () => wsDir;