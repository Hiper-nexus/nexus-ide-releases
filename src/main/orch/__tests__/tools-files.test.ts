import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildFileTools } from '../tools-files';
import { testProjectScope } from './scope-fixture';

const workspace = vi.hoisted(() => ({ current: '' }));
const missionLookup = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));
vi.mock('../project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: missionLookup.get },
  }),
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-files');
const wsDir = path.join(testDir, 'workspace');

describe('tools-files', () => {
  beforeEach(() => {
    missionLookup.get.mockReset();
  });

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

  it('nexus_file_write creates missing parent directories without leaving the workspace', async () => {
    const write = buildFileTools().find((tool) => tool.name === 'nexus_file_write')!;

    await expect(
      write.handler(
        { path: 'generated/nested/result.txt', content: 'scoped' },
        fakeCtx(),
      ),
    ).resolves.toMatchObject({ existed: false, path: 'generated/nested/result.txt' });
    expect(
      fs.readFileSync(path.join(wsDir, 'generated', 'nested', 'result.txt'), 'utf8'),
    ).toBe('scoped');
  });

  it.each([
    '.agents/skills/post-scan/SKILL.md',
    'packages/app/.codex/skills/post-scan/SKILL.md',
  ])(
    'denies governed post-scan skill creation at %s before touching disk',
    async (relativePath) => {
      missionLookup.get.mockReturnValue({ intentContract: { lane: 'build' } });
      const target = path.join(wsDir, ...relativePath.split('/'));
      fs.rmSync(path.join(wsDir, relativePath.split('/')[0]), {
        recursive: true,
        force: true,
      });
      const write = buildFileTools().find(
        (tool) => tool.name === 'nexus_file_write',
      )!;

      await expect(
        write.handler(
          { path: relativePath, content: '# must-not-land' },
          {
            ...fakeCtx(),
            role: 'worker',
            missionId: 'mission-governed',
            governedNativeProvider: 'codex',
          },
        ),
      ).rejects.toThrow(/Codex control path/i);
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  it('fails closed without mutating the file when mission authority is missing', async () => {
    const target = path.join(wsDir, 'missing-mission-write.txt');
    fs.rmSync(target, { force: true });
    missionLookup.get.mockReturnValue(null);
    const write = buildFileTools().find((tool) => tool.name === 'nexus_file_write')!;

    await expect(
      write.handler(
        { path: 'missing-mission-write.txt', content: 'must-not-land' },
        { ...fakeCtx(), missionId: 'missing-mission' },
      ),
    ).rejects.toThrow(/mission authority unavailable; file write denied/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('fails closed without mutating the file when mission lookup throws', async () => {
    const target = path.join(wsDir, 'failed-mission-lookup-write.txt');
    fs.rmSync(target, { force: true });
    missionLookup.get.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const write = buildFileTools().find((tool) => tool.name === 'nexus_file_write')!;

    await expect(
      write.handler(
        { path: 'failed-mission-lookup-write.txt', content: 'must-not-land' },
        { ...fakeCtx(), missionId: 'mission-with-failed-lookup' },
      ),
    ).rejects.toThrow(/mission authority unavailable; file write denied/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('uses the plan-lane writable-path policy before mutating the file', async () => {
    const target = path.join(wsDir, 'src', 'plan-lane-denied.ts');
    fs.rmSync(target, { force: true });
    missionLookup.get.mockReturnValue({
      intentContract: { lane: 'plan' },
    });
    const write = buildFileTools().find((tool) => tool.name === 'nexus_file_write')!;

    await expect(
      write.handler(
        { path: 'src/plan-lane-denied.ts', content: 'must-not-land' },
        { ...fakeCtx(), missionId: 'plan-mission' },
      ),
    ).rejects.toThrow(/plan lane denies write/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rejects creation through a symbolic-link parent outside the workspace', async () => {
    const outsideDir = path.join(testDir, 'outside-create');
    const linkedParent = path.join(wsDir, 'linked-parent');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, linkedParent, 'dir');
    const write = buildFileTools().find((tool) => tool.name === 'nexus_file_write')!;

    await expect(
      write.handler({ path: 'linked-parent/owned.txt', content: 'escaped' }, fakeCtx()),
    ).rejects.toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outsideDir, 'owned.txt'))).toBe(false);
  });

  it('rejects a workspace-internal symlink instead of following it for reads', async () => {
    const target = path.join(wsDir, 'symlink-target.txt');
    const link = path.join(wsDir, 'symlink-read.txt');
    fs.writeFileSync(target, 'target-content');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link, 'file');
    const read = buildFileTools().find((tool) => tool.name === 'nexus_file_read')!;

    await expect(read.handler({ path: 'symlink-read.txt' }, fakeCtx())).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it('rejects mutable hardlinks so an external inode cannot be overwritten', async () => {
    const outside = path.join(testDir, 'outside-hardlink.txt');
    const linked = path.join(wsDir, 'linked-hardlink.txt');
    fs.writeFileSync(outside, 'outside-original');
    fs.rmSync(linked, { force: true });
    fs.linkSync(outside, linked);
    const write = buildFileTools().find((tool) => tool.name === 'nexus_file_write')!;

    await expect(
      write.handler({ path: 'linked-hardlink.txt', content: 'attacker-write' }, fakeCtx()),
    ).rejects.toThrow(/hardlink/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside-original');
  });

  it('rejects hardlinks for reads so external inode contents cannot cross scope', async () => {
    const outside = path.join(testDir, 'outside-hardlink-read.txt');
    const linked = path.join(wsDir, 'linked-hardlink-read.txt');
    fs.writeFileSync(outside, 'outside-private-content');
    fs.rmSync(linked, { force: true });
    fs.linkSync(outside, linked);
    const read = buildFileTools().find((tool) => tool.name === 'nexus_file_read')!;

    await expect(
      read.handler({ path: 'linked-hardlink-read.txt' }, fakeCtx()),
    ).rejects.toThrow(/hardlink/i);
  });

  it('nexus_file_search finds files by pattern', async () => {
    const tools = buildFileTools();
    const search = tools.find((t) => t.name === 'nexus_file_search')!;
    const result = await search.handler({ pattern: '*.ts' }, fakeCtx()) as { files: string[] };
    expect(result).toHaveProperty('files');
    expect(result.files).toContain('src/index.ts');
  });

  it('nexus_file_search omits symbolic links and other non-regular entries', async () => {
    const target = path.join(wsDir, 'search-target.ts');
    const link = path.join(wsDir, 'search-link.ts');
    fs.writeFileSync(target, 'export {};');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link, 'file');
    const search = buildFileTools().find((tool) => tool.name === 'nexus_file_search')!;

    const result = (await search.handler({ pattern: '*.ts' }, fakeCtx())) as {
      files: string[];
    };
    expect(result.files).toContain('search-target.ts');
    expect(result.files).not.toContain('search-link.ts');
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
    scope: testProjectScope({ rootRealPath: fs.realpathSync(wsDir) }),
  };
}
