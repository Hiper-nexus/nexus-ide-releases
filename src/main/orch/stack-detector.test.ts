import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectWorkspaceStacks } from './stack-detector';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  fs.writeFileSync(path.join(root, rel), contents);
}

describe('detectWorkspaceStacks', () => {
  it('returns nothing without a workspace path', () => {
    expect(detectWorkspaceStacks(undefined)).toEqual([]);
  });

  it('detects node + framework deps from package.json', () => {
    write(
      'package.json',
      JSON.stringify({
        dependencies: { react: '1', electron: '1' },
        devDependencies: { vite: '1' },
      }),
    );
    const stacks = detectWorkspaceStacks(root);
    expect(stacks).toEqual(expect.arrayContaining(['node', 'react', 'electron', 'vite']));
  });

  it('does not throw on invalid package.json but still marks node', () => {
    write('package.json', '{ not json');
    expect(detectWorkspaceStacks(root)).toContain('node');
  });

  it('detects marker files for other stacks', () => {
    write('tsconfig.json', '{}');
    write('go.mod', 'module x');
    write('Cargo.toml', '[package]');
    write('requirements.txt', 'flask');
    const stacks = detectWorkspaceStacks(root);
    expect(stacks).toEqual(
      expect.arrayContaining(['typescript', 'go', 'rust', 'python']),
    );
  });
});
