import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildFileTools } from '../tools-files';

const workspace = vi.hoisted(() => ({ current: '' }));
vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-files');
const wsDir = path.join(testDir, 'workspace');

describe('tools-files', () => {
  beforeAll(() => {
    workspace.current = wsDir;
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'readme.md'), '# Hello\nWorld\n', 'utf-8');
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('nexus_file_open reads a file', async () => {
    const tools = buildFileTools();
    const open = tools.find((t) => t.name === 'nexus_file_open')!;
    const result = await open.handler({ path: 'readme.md' }, fakeCtx());
    expect(result).toHaveProperty('content', '# Hello\nWorld\n');
    expect(result).toHaveProperty('path', 'readme.md');
  });

  it('nexus_file_close is a safe no-op', async () => {
    const tools = buildFileTools();
    const close = tools.find((t) => t.name === 'nexus_file_close')!;
    await expect(close.handler({ path: 'readme.md' }, fakeCtx())).resolves.toMatchObject({
      closed: true,
      path: 'readme.md',
    });
  });

  it('nexus_file_open throws for missing file', async () => {
    const tools = buildFileTools();
    const open = tools.find((t) => t.name === 'nexus_file_open')!;
    await expect(open.handler({ path: 'nonexistent.txt' }, fakeCtx())).rejects.toThrow();
  });

  it('nexus_file_read supports offset and limit', async () => {
    const tools = buildFileTools();
    const read = tools.find((t) => t.name === 'nexus_file_read')!;
    const result = await read.handler({ path: 'readme.md', offset: 1, limit: 1 }, fakeCtx());
    expect(result).toHaveProperty('content', '# Hello');
  });

  it('fails closed on an unbounded huge read and streams an explicit range', async () => {
    const hugePath = path.join(wsDir, 'huge.log');
    fs.writeFileSync(hugePath, `${'x'.repeat(9 * 1024 * 1024)}\ntail\n`);
    const read = buildFileTools().find((tool) => tool.name === 'nexus_file_read')!;
    await expect(read.handler({ path: 'huge.log' }, fakeCtx())).rejects.toThrow(
      /use offset \+ limit/,
    );
    await expect(
      read.handler({ path: 'huge.log', offset: 2, limit: 1 }, fakeCtx()),
    ).resolves.toMatchObject({ content: 'tail', offset: 2, limit: 1 });
  });

  it('nexus_file_write creates a new file', async () => {
    const tools = buildFileTools();
    const write = tools.find((t) => t.name === 'nexus_file_write')!;
    const result = await write.handler(
      { path: 'new-file.txt', content: 'test content' },
      fakeCtx(),
    );
    expect(result).toHaveProperty('existed', false);
    expect(result).toHaveProperty('path', 'new-file.txt');
    const content = fs.readFileSync(path.join(wsDir, 'new-file.txt'), 'utf-8');
    expect(content).toBe('test content');
  });

  it('nexus_file_search finds files by pattern', async () => {
    const tools = buildFileTools();
    const search = tools.find((t) => t.name === 'nexus_file_search')!;
    const result = await search.handler({ pattern: '*.ts' }, fakeCtx()) as { files: string[] };
    expect(result).toHaveProperty('files');
    expect(result.files).toContain('src/index.ts');
  });

  it('denies paths outside the active workspace', async () => {
    const tools = buildFileTools();
    const read = tools.find((t) => t.name === 'nexus_file_read')!;
    await expect(read.handler({ path: '../outside.txt' }, fakeCtx())).rejects.toThrow(
      /escapes workspace/,
    );
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
