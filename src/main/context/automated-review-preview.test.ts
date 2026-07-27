import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAutomatedReviewPreviewRoot } from './automated-review-preview';

const roots: string[] = [];

function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-preview-'));
  roots.push(root);
  return root;
}

function writeIndex(root: string, relativeRoot: string, html: string): string {
  const output = path.join(root, relativeRoot);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'index.html'), html);
  return output;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('automated review preview artifact', () => {
  it('selects one built static output from a bounded monorepo checkout', () => {
    const root = checkout();
    const output = writeIndex(
      root,
      'apps/web/dist',
      '<!doctype html><html><script src="/assets/app.js"></script></html>',
    );

    expect(resolveAutomatedReviewPreviewRoot(root)).toEqual({
      root: fs.realpathSync.native(output),
      indexPath: fs.realpathSync.native(path.join(output, 'index.html')),
      relativeRoot: path.join('apps', 'web', 'dist'),
      kind: 'built-output',
    });
  });

  it('accepts a genuinely static root when no build output exists', () => {
    const root = checkout();
    writeIndex(
      root,
      '.',
      '<!doctype html><html><script src="./app.js"></script></html>',
    );

    expect(resolveAutomatedReviewPreviewRoot(root)).toMatchObject({
      root: fs.realpathSync.native(root),
      relativeRoot: '.',
      kind: 'static-root',
    });
  });

  it('rejects a source-only framework entry instead of reviewing a blank page', () => {
    const root = checkout();
    writeIndex(
      root,
      '.',
      '<!doctype html><html><script type="module" src="/src/main.tsx"></script></html>',
    );

    expect(() => resolveAutomatedReviewPreviewRoot(root)).toThrow(
      /needs one built static UI/i,
    );
  });

  it('fails closed when more than one build could be the reviewed product', () => {
    const root = checkout();
    writeIndex(root, 'dist', '<!doctype html><html>dist</html>');
    writeIndex(root, 'apps/admin/out', '<!doctype html><html>admin</html>');

    expect(() => resolveAutomatedReviewPreviewRoot(root)).toThrow(
      /multiple UI artifacts.*apps.admin.out.*dist/i,
    );
  });

  it('treats a static root plus a built output as ambiguous', () => {
    const root = checkout();
    writeIndex(root, '.', '<!doctype html><html>root</html>');
    writeIndex(root, 'dist', '<!doctype html><html>dist</html>');

    expect(() => resolveAutomatedReviewPreviewRoot(root)).toThrow(
      /multiple UI artifacts.*dist.*\./i,
    );
  });

  it('fails closed when the entry bound hides a later artifact', () => {
    const root = checkout();
    writeIndex(root, 'dist', '<!doctype html><html>first</html>');
    writeIndex(
      root,
      'zzzz/build',
      '<!doctype html><html>second</html>',
    );

    expect(() =>
      resolveAutomatedReviewPreviewRoot(root, { maxWalkEntries: 1 }),
    ).toThrow(/artifact scan was incomplete.*entry limit 1/i);
  });

  it('accepts a root build alongside an ordinary deep source tree', () => {
    const root = checkout();
    const output = writeIndex(
      root,
      'dist',
      '<!doctype html><html>built</html>',
    );
    const deepSource = path.join(
      root,
      'src/a/b/c/d/e/f/g/h/i/j/k',
    );
    fs.mkdirSync(deepSource, { recursive: true });
    fs.writeFileSync(path.join(deepSource, 'module.ts'), 'export {};');

    expect(resolveAutomatedReviewPreviewRoot(root)).toMatchObject({
      root: fs.realpathSync.native(output),
      relativeRoot: 'dist',
      kind: 'built-output',
    });
  });

  it('does not follow a build or index symlink outside the candidate checkout', () => {
    const root = checkout();
    const foreign = checkout();
    writeIndex(foreign, 'dist', '<!doctype html><html>foreign</html>');
    fs.symlinkSync(path.join(foreign, 'dist'), path.join(root, 'dist'));

    expect(() => resolveAutomatedReviewPreviewRoot(root)).toThrow(
      /needs one built static UI/i,
    );
  });

  it('supports Electron Forge Vite renderer output', () => {
    const root = checkout();
    const output = writeIndex(
      root,
      '.vite/renderer/main_window',
      '<!doctype html><html><script src="./assets/app.js"></script></html>',
    );

    expect(resolveAutomatedReviewPreviewRoot(root)).toMatchObject({
      root: fs.realpathSync.native(output),
      relativeRoot: path.join('.vite', 'renderer', 'main_window'),
      kind: 'built-output',
    });
  });
});
