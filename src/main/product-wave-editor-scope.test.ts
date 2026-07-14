/**
 * Editor open/apply path containment — exercises the same adapter as
 * product-wave-ipc (resolveScopedPath / resolveScopedPathCandidate).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../shared/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('product-wave editor path containment (via scoped-workspace-fs)', () => {
  it('rejects sibling-prefix and ../proj2 escapes for open and apply paths', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ed-scope-'));
    dirs.push(base);
    const project = path.join(base, 'proj');
    const sibling = path.join(base, 'proj2');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(project, 'a.ts'), 'export {}\n');
    fs.writeFileSync(path.join(sibling, 'secret.ts'), 'evil\n');
    const projectReal = fs.realpathSync(project);
    const siblingReal = fs.realpathSync(sibling);

    const scope: ProjectExecutionScope = {
      version: 1,
      installationId: 'i',
      projectId: 'p',
      checkoutId: 'c',
      rootRealPath: projectReal,
      identitySource: 'manifest',
    };

    const scopeMod = await import('./persistence/renderer-workspace-scope');
    vi.spyOn(scopeMod, 'requireRendererWorkspaceScope').mockReturnValue(scope);

    const {
      resolveScopedPath,
      resolveScopedPathCandidate,
    } = await import('./security/scoped-workspace-fs');
    const sender = { id: 1 } as Electron.WebContents;

    expect(resolveScopedPathCandidate(sender, 'a.ts')).toBe(
      path.join(projectReal, 'a.ts'),
    );
    expect(() =>
      resolveScopedPathCandidate(sender, '../proj2/secret.ts'),
    ).toThrow(/escapes/);
    expect(() =>
      resolveScopedPathCandidate(sender, path.join(siblingReal, 'secret.ts')),
    ).toThrow(/escapes/);
    expect(() =>
      resolveScopedPath(sender, path.join(siblingReal, 'secret.ts')),
    ).toThrow(/escapes/);
    // Absolute path under sibling must not be writable via apply path
    expect(() =>
      resolveScopedPath(sender, path.join(siblingReal, 'secret.ts')),
    ).toThrow(/escapes/);
  });
});
