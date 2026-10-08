import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { proveMainOwnedCommandForSmoke } from './smoke-owned-command';
import { NEXUS_APPLE_TEAM_ID } from './pty/darwin-pty-supervisor';
import { testProjectScope } from './orch/__tests__/scope-fixture';
import type { execOwnedCheck } from './orch/owned-check-exec';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function input() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-owned-smoke-test-')));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  return { userData: root, scope: { ...testProjectScope(), rootRealPath: workspace }, assertCurrent: vi.fn(), signal: new AbortController().signal };
}

it('keeps ad-hoc smoke explicitly unverified without asking for normal command authority', async () => {
  const execute = vi.fn<typeof execOwnedCheck>();
  expect(await proveMainOwnedCommandForSmoke(await input(), { platform: 'darwin', seal: () => ({ teamIdentifier: null }), execute }))
    .toEqual({ status: 'unavailable', reason: 'ad-hoc' });
  expect(execute).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'darwin')('uses the confined production plan and waits for physical proof before passing or deleting HOME', async () => {
  const fixture = await input();
  let exit!: () => void;
  const physicalExit = new Promise<void>(resolve => { exit = resolve; });
  let runtime = '';
  const execute = vi.fn<typeof execOwnedCheck>(async ({ plan, request }) => {
    runtime = path.dirname(plan.env.HOME!);
    expect(plan.file).toBe('/usr/bin/sandbox-exec');
    expect(plan.args[1]).toContain('(deny network*)');
    expect(plan.args[1]).toContain('(deny file-write*)');
    expect(Buffer.byteLength(plan.args[1])).toBeLessThan(65536);
    expect(await fs.readdir(path.join(runtime, 'dense-bin'))).toHaveLength(768);
    expect(request.scope).toEqual(fixture.scope);
    return { exitCode: 0, stdout: `${plan.args.at(-1)}\n`, stderr: '', aborted: false, timedOut: false, physicalExit };
  });
  let settled = false;
  const pending = proveMainOwnedCommandForSmoke(fixture, { seal: () => ({ teamIdentifier: NEXUS_APPLE_TEAM_ID }), execute })
    .finally(() => { settled = true; });
  await vi.waitFor(() => expect(execute).toHaveBeenCalled());
  expect(settled).toBe(false);
  await expect(fs.stat(runtime)).resolves.toBeDefined();
  exit();
  expect(await pending).toMatchObject({ status: 'passed', densePathFiles: 768, exitCode: 0, physicalExitProven: true });
  await vi.waitFor(async () => expect(await fs.stat(runtime).catch(() => null)).toBeNull());
});

it.runIf(process.platform === 'darwin').each(['missing-nonce', 'logical-timeout', 'nonzero'])('rejects %s even when physical exit is proven', async fault => {
  const execute: typeof execOwnedCheck = async ({ plan }) => ({
    exitCode: fault === 'nonzero' ? 1 : 0, stdout: fault === 'missing-nonce' ? 'wrong' : plan.args.at(-1)!,
    stderr: '', aborted: false, timedOut: fault === 'logical-timeout', physicalExit: Promise.resolve(),
  });
  await expect(proveMainOwnedCommandForSmoke(await input(), { seal: () => ({ teamIdentifier: NEXUS_APPLE_TEAM_ID }), execute }))
    .rejects.toThrow('owned-smoke-command-failed');
});
