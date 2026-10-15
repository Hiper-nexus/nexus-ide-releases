import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { buildFileTools } from './tools-files';

const active = vi.hoisted(() => ({ root: '' }));

vi.mock('../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => active.root,
}));

const testRoot = path.join(os.tmpdir(), 'nexus-tools-files-project-scope');
const projectA = path.join(testRoot, 'project-a');
const projectB = path.join(testRoot, 'project-b');

function contextForA(): AgentGateContext {
  return {
    token: 'token-a',
    label: 'agent-a',
    role: 'worker',
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: Object.freeze({
      version: 1,
      installationId: 'installation-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: fs.realpathSync(projectA),
      identitySource: 'manifest',
    }),
  };
}

describe('file tools project scope', () => {
  beforeAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fs.writeFileSync(path.join(projectA, 'same.txt'), 'from-a');
    fs.writeFileSync(path.join(projectB, 'same.txt'), 'from-b');
    active.root = projectB;
  });

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('reads from the token checkout instead of the active workspace', async () => {
    const tool = buildFileTools().find((candidate) => candidate.name === 'nexus_file_read');
    expect(tool).toBeDefined();

    await expect(tool!.handler({ path: 'same.txt' }, contextForA())).resolves.toMatchObject({
      content: 'from-a',
    });
  });

  it('reads and writes only the task worktree while retaining project coordinates', async () => {
    const ctx = contextForA();
    ctx.executionScope = Object.freeze({
      ...ctx.scope,
      rootRealPath: fs.realpathSync(projectB),
    });
    const tools = buildFileTools();
    const read = tools.find((candidate) => candidate.name === 'nexus_file_read')!;
    const write = tools.find((candidate) => candidate.name === 'nexus_file_write')!;

    await expect(read.handler({ path: 'same.txt' }, ctx)).resolves.toMatchObject({
      content: 'from-b',
    });
    await write.handler({ path: 'worker.txt', content: 'isolated' }, ctx);
    expect(fs.existsSync(path.join(projectA, 'worker.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(projectB, 'worker.txt'), 'utf8')).toBe('isolated');
  });

  it('reads file content off the Main loop (full, line range and open) (#22)', async () => {
    fs.writeFileSync(path.join(projectA, 'lines.txt'), 'one\ntwo\r\nthree\nfour');
    const tools = buildFileTools();
    const read = tools.find((candidate) => candidate.name === 'nexus_file_read')!;
    const open = tools.find((candidate) => candidate.name === 'nexus_file_open')!;
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const readSync = vi.spyOn(fs, 'readSync');
    try {
      await expect(read.handler({ path: 'lines.txt' }, contextForA())).resolves.toMatchObject({
        content: 'one\ntwo\r\nthree\nfour',
      });
      await expect(read.handler({ path: 'lines.txt', offset: 2, limit: 2 }, contextForA()))
        .resolves.toMatchObject({ offset: 2, limit: 2, content: 'two\nthree' });
      await expect(open.handler({ path: 'same.txt' }, contextForA())).resolves.toMatchObject({
        content: 'from-a',
      });
      expect(readFileSync).not.toHaveBeenCalled();
      expect(readSync).not.toHaveBeenCalled();
    } finally {
      readFileSync.mockRestore();
      readSync.mockRestore();
    }
  });
});
