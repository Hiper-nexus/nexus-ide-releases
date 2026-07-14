/**
 * Editor open/apply path containment — same adapter as product-wave-ipc.
 * Open/read must use resolveScopedPath (realpath), not lexical-only candidate.
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
  it('treats only ENOENT as a new empty editor file', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ed-read-'));
    dirs.push(base);
    const missing = path.join(base, 'missing.ts');
    const directory = path.join(base, 'directory');
    fs.mkdirSync(directory);
    const { readEditorBytesOrEmpty } = await import('./product-wave-ipc');

    expect(readEditorBytesOrEmpty(missing)).toEqual(Buffer.from(''));
    expect(() => readEditorBytesOrEmpty(directory)).toThrow();
  });

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

    expect(resolveScopedPath(sender, 'a.ts')).toBe(
      fs.realpathSync(path.join(projectReal, 'a.ts')),
    );
    expect(() =>
      resolveScopedPathCandidate(sender, '../proj2/secret.ts'),
    ).toThrow(/escapes/);
    expect(() =>
      resolveScopedPath(sender, path.join(siblingReal, 'secret.ts')),
    ).toThrow(/escapes/);
  });

  it('rejects workspace symlink that realpaths to sibling secret (editorOpen path)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ed-symlink-'));
    dirs.push(base);
    const project = path.join(base, 'proj');
    const sibling = path.join(base, 'proj2');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const secretPath = path.join(sibling, 'secret.ts');
    fs.writeFileSync(secretPath, 'LEAKED_SECRET_BYTES\n');
    // Symlink inside project pointing outside — lexical path looks in-scope.
    const leakLink = path.join(project, 'leak');
    fs.symlinkSync(secretPath, leakLink);

    const projectReal = fs.realpathSync(project);
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

    const { resolveScopedPath } = await import(
      './security/scoped-workspace-fs'
    );
    const sender = { id: 2 } as Electron.WebContents;

    // Open/read must realpath and reject workspace symlink → outside.
    expect(() => resolveScopedPath(sender, 'leak')).toThrow(/escapes/);
    // Must never read the secret through the symlink.
    expect(() => {
      const resolved = resolveScopedPath(sender, 'leak');
      return fs.readFileSync(resolved, 'utf8');
    }).toThrow(/escapes/);
    // Absolute escape via realpath of link
    expect(() => resolveScopedPath(sender, leakLink)).toThrow(/escapes/);
  });
});
