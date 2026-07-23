import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './scope-fixture';

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  responses: new Map<string, { stdout: string; stderr: string }>(),
}));

vi.mock('../../runtime/git-command', () => ({
  assertSafeLocalGitConfig: vi.fn(),
  ProcessGitRunner: class {
    run(_cwd: string, args: readonly string[]) {
      const command = [...args];
      state.calls.push(command);
      const response = state.responses.get(command.join(' '));
      if (!response) throw new Error(`unexpected Git call: ${command.join(' ')}`);
      return response;
    }
  },
}));

import { buildGitTools } from '../tools-git';

const workspace = path.join(os.tmpdir(), 'nexus-git-sync-mocked-workspace');

function response(stdout = '', stderr = ''): { stdout: string; stderr: string } {
  return { stdout, stderr };
}

function setCleanRepository(divergence: string): void {
  state.responses.set('rev-parse --abbrev-ref HEAD', response('main'));
  state.responses.set('status --porcelain=v1 --untracked-files=no', response(''));
  state.responses.set('status --porcelain=v1 --untracked-files=normal', response('?? notes.txt'));
  state.responses.set(
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
    response('origin/main'),
  );
  state.responses.set('remote get-url origin', response('https://github.com/acme/project.git'));
  state.responses.set('fetch --prune origin', response(''));
  state.responses.set('rev-list --left-right --count HEAD...@{upstream}', response(divergence));
}

function fakeCtx() {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null as string[] | null,
    allowedSkills: null as string[] | null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: testProjectScope({ rootRealPath: fs.realpathSync(workspace) }),
  };
}

describe('nexus_git_sync', () => {
  beforeAll(() => {
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    state.calls.length = 0;
    state.responses.clear();
  });

  it('fast-forwards a clean branch and leaves unrelated untracked files alone', async () => {
    setCleanRepository('0\t2');
    state.responses.set('merge --ff-only @{upstream}', response('Fast-forward'));

    const sync = buildGitTools().find((tool) => tool.name === 'nexus_git_sync')!;
    await expect(sync.handler({}, fakeCtx())).resolves.toMatchObject({
      status: 'updated',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 2,
      untrackedFiles: 1,
    });
    expect(state.calls).toContainEqual(['fetch', '--prune', 'origin']);
    expect(state.calls).toContainEqual(['merge', '--ff-only', '@{upstream}']);
  });

  it('does not fetch or mutate when tracked local files are changed', async () => {
    state.responses.set('rev-parse --abbrev-ref HEAD', response('main'));
    state.responses.set('status --porcelain=v1 --untracked-files=no', response(' M src/app.ts'));
    state.responses.set('status --porcelain=v1 --untracked-files=normal', response(' M src/app.ts'));

    const sync = buildGitTools().find((tool) => tool.name === 'nexus_git_sync')!;
    await expect(sync.handler({}, fakeCtx())).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/arquivos já versionados/i),
    });
    expect(state.calls).not.toContainEqual(['fetch', '--prune', 'origin']);
    expect(state.calls).not.toContainEqual(['merge', '--ff-only', '@{upstream}']);
  });

  it('reports a local-ahead branch instead of pushing or merging it', async () => {
    setCleanRepository('3\t0');

    const sync = buildGitTools().find((tool) => tool.name === 'nexus_git_sync')!;
    await expect(sync.handler({}, fakeCtx())).resolves.toMatchObject({
      status: 'blocked',
      ahead: 3,
      behind: 0,
      reason: expect.stringMatching(/não fiz push/i),
    });
    expect(state.calls).not.toContainEqual(['merge', '--ff-only', '@{upstream}']);
  });

  it('never starts push when authority is revoked after remote preflight', async () => {
    state.responses.set(
      'remote get-url origin',
      response('https://github.com/acme/project.git'),
    );
    const push = buildGitTools().find((tool) => tool.name === 'nexus_git_push')!;
    const controller = new AbortController();

    const pending = push.handler(
      { remote: 'origin', branch: 'main' },
      fakeCtx(),
      { signal: controller.signal },
    );
    expect(state.calls).toContainEqual(['remote', 'get-url', 'origin']);
    controller.abort(new Error('session_authority_revoked'));

    await expect(pending).rejects.toThrow(/session_authority_revoked/i);
    expect(state.calls).not.toContainEqual(['push', 'origin', 'main']);
  });
});
