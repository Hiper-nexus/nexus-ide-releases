import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSafeUiKitCwd, claimUiKitProjectWrite, resetUiKitProjectWritesForTests, runUiKitCli } from './ui-kit-cli';
import { callMcpToolOnce } from './ui-kit-mcp-call';
import { resolveUiKitWorkspaceTarget } from './ui-kit-workspaces';

// Only the vendor process is replaced. Workspace discovery, junctions, guards
// and the shared CLI/MCP write claim all run against real filesystem fixtures.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

let fixture = '';
let root = '';
let one = '';
let two = '';
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kit-install-root-'));
  root = path.join(fixture, 'repo');
  for (const name of ['one', 'two']) {
    const dir = path.join(root, 'apps', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  one = resolveUiKitWorkspaceTarget(root, 'apps/one').cwd;
  two = resolveUiKitWorkspaceTarget(root, 'apps/two').cwd;
});
afterEach(() => {
  vi.resetAllMocks();
  resetUiKitProjectWritesForTests();
  fs.rmSync(fixture, { recursive: true, force: true });
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: undefined,
  }) as unknown as ReturnType<typeof spawn>;
}

describe('shared monorepo installation root', () => {
  it('keeps Main installation authority when selecting a declared component destination', () => {
    expect(resolveUiKitWorkspaceTarget(root, 'apps/one')).toEqual({ cwd: one, installationRoot: root });
    expect(() => resolveUiKitWorkspaceTarget(root, '../outside')).toThrow(/unknown workspace/);
  });

  it.each([false, true])('refuses a root node_modules junction from the child (dangling=%s)', dangling => {
    const shared = path.join(fixture, 'shared-install');
    if (!dangling) fs.mkdirSync(shared);
    fs.symlinkSync(shared, path.join(root, 'node_modules'), 'junction');
    expect(() => assertSafeUiKitCwd(one, { writes: true, installationRoot: root }))
      .toThrow(/node_modules is a symlink/);
    expect(assertSafeUiKitCwd(one, { installationRoot: root })).toBe(one);
  });

  it('still refuses a child node_modules junction with an ordinary root install', () => {
    fs.mkdirSync(path.join(root, 'node_modules'));
    const shared = path.join(fixture, 'shared-install');
    fs.mkdirSync(shared);
    fs.symlinkSync(shared, path.join(one, 'node_modules'), 'junction');
    expect(() => assertSafeUiKitCwd(one, { writes: true, installationRoot: root }))
      .toThrow(/node_modules is a symlink/);
  });

  it('shares one claim between siblings and root, releasing it idempotently', () => {
    const release = claimUiKitProjectWrite(one, 1_000, root);
    expect(() => claimUiKitProjectWrite(two, 2_000, root)).toThrow(/still running/);
    expect(() => claimUiKitProjectWrite(root, 2_000)).toThrow(/still running/);
    release();
    const next = claimUiKitProjectWrite(two, 3_000, root);
    release();
    expect(() => claimUiKitProjectWrite(one, 4_000, root)).toThrow(/still running/);
    next();
  });

  it('keeps independent nested projects concurrent when they are not selected workspaces', () => {
    const independent = path.join(root, 'independent');
    fs.mkdirSync(independent);
    fs.writeFileSync(path.join(independent, 'package.json'), '{}');
    const release = claimUiKitProjectWrite(one, 1_000, root);
    const other = claimUiKitProjectWrite(independent, 1_000);
    other();
    release();
  });

  it('refuses a supplied root outside the trusted component scope', () => {
    const outside = path.join(fixture, 'outside');
    fs.mkdirSync(outside);
    expect(() => assertSafeUiKitCwd(one, { writes: true, installationRoot: outside })).toThrow();
    expect(() => claimUiKitProjectWrite(one, 1_000, outside)).toThrow();
  });

  it('refuses a child junction redirected out of the trusted root', () => {
    const outside = path.join(fixture, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link, 'junction');
    expect(() => assertSafeUiKitCwd(link, { writes: true, installationRoot: root })).toThrow();
    expect(() => claimUiKitProjectWrite(link, 1_000, root)).toThrow();
  });

  it('uses the same physical root for a junction alias', () => {
    const alias = path.join(fixture, 'alias');
    fs.symlinkSync(root, alias, 'junction');
    const release = claimUiKitProjectWrite(one, 1_000, root);
    expect(() => claimUiKitProjectWrite(path.join(alias, 'apps/two'), 2_000, alias)).toThrow(/still running/);
    release();
  });

  it.each(['cli', 'mcp'] as const)('%s refuses the root junction before any vendor spawn', async runner => {
    const shared = path.join(fixture, 'shared-install');
    fs.mkdirSync(shared);
    fs.symlinkSync(shared, path.join(root, 'node_modules'), 'junction');
    vi.mocked(spawn).mockImplementation(() => { throw new Error('vendor must not spawn'); });
    const request = { kit: 'boardui' as const, cwd: one, writes: true, installationRoot: root };
    const run = runner === 'cli'
      ? runUiKitCli({ ...request, args: ['add', 'button'] })
      : callMcpToolOnce({ ...request, method: 'tools/call', tool: 'install_components' }, { platform: 'linux' });
    await expect(run).rejects.toMatchObject({ code: 'SHARED_NODE_MODULES' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a CLI install blocks an MCP install in the sibling until the CLI closes', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const first = runUiKitCli({ kit: 'boardui', cwd: one, args: ['add', 'button'], writes: true, installationRoot: root });
    const sibling = () => callMcpToolOnce({ kit: 'boardui', cwd: two, installationRoot: root,
      writes: true, method: 'tools/call', tool: 'install_components' }, {
      platform: 'linux', spawnProcess: () => { throw new Error('sibling must not spawn'); },
    });
    try {
      await expect(sibling()).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      expect(vi.mocked(spawn).mock.calls[0]?.[2]?.cwd).toBe(one);
    } finally {
      child.emit('close', 0);
      await first;
    }
    const next = claimUiKitProjectWrite(two, 1_000, root);
    next();
  });
});
