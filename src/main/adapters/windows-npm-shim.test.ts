import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsNpmShimInvocation, windowsNpmShimTarget } from './windows-npm-shim';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Windows npm shim ownership', () => {
  it('resolves the package entrypoint named by a Codex cmd shim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-npm-shim-'));
    roots.push(root);
    const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      bin: { codex: 'bin/codex.js' },
    }));
    const entrypoint = path.join(packageRoot, 'bin', 'codex.js');
    fs.writeFileSync(entrypoint, '');
    const shim = path.join(root, 'codex.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');

    expect(windowsNpmShimTarget('codex', shim)).toBe(entrypoint);
    expect(windowsNpmShimInvocation('codex', shim, 'C:\\node.exe')).toEqual({
      executable: 'C:\\node.exe',
      argsPrefix: [entrypoint],
    });
    expect(windowsNpmShimTarget('claude', shim)).toBeNull();

    fs.writeFileSync(shim,
      '@ECHO off\r\nREM node_modules\\@openai\\codex\\bin\\codex.js\r\n"%~dp0%\\other.js" %*\r\n',
    );
    expect(windowsNpmShimTarget('codex', shim)).toBeNull();
  });

  it('launches a native npm package binary directly instead of feeding it to Node', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-shim-'));
    roots.push(root);
    const packageRoot = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      bin: { claude: 'bin/claude.exe' },
    }));
    const entrypoint = path.join(packageRoot, 'bin', 'claude.exe');
    fs.writeFileSync(entrypoint, 'MZ');
    const shim = path.join(root, 'claude.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n');

    expect(windowsNpmShimInvocation('claude', shim, null)).toEqual({
      executable: entrypoint,
      argsPrefix: [],
    });
  });
});
