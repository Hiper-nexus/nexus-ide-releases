import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSyncProcessUses, checkAllowlist } from './check-main-sync.mjs';

describe('Main synchronous process ratchet (F-764)', () => {
  it.each([
    ['named import', "import { execSync } from 'node:child_process'; execSync('git status');"],
    ['renamed import', "import { spawnSync as run } from 'child_process'; run('git', ['status']);"],
    ['namespace', "import * as cp from 'node:child_process'; cp.execFileSync('git', ['status']);"],
    ['default', "import cp from 'node:child_process'; cp.spawnSync('git');"],
    ['require destructuring', "const { execSync: run } = require('child_process'); run('git status');"],
    ['require namespace', "const cp = require('node:child_process'); cp['spawnSync']('git');"],
    ['computed member', "const cp = require('child_process'); cp['exec' + 'Sync']('git status');"],
    ['dynamic import', "const { execFileSync: run } = await import('node:child_process'); run('git');"],
    ['function alias', "import { execSync as run } from 'child_process'; const alsoRun = run; alsoRun('git');"],
    ['function argument', "import { execSync } from 'child_process'; schedule(execSync);"],
    ['namespace alias', "import * as cp from 'child_process'; const other = cp; other.execSync('git');"],
    ['import equals', "import cp = require('child_process'); cp.execSync('git');"],
    ['bound alias', "import { execSync } from 'child_process'; const run = execSync.bind(null); run('git');"],
    ['default callback', "import { execSync } from 'child_process'; function probe(run = execSync) { run('git'); }"],
    ['assigned alias', "import { execSync } from 'child_process'; let run; run = execSync; run('git');"],
  ])('detects %s, including aliases', (_label, source) => {
    const uses = findSyncProcessUses(source);
    expect(uses.some((use) => use.kind === 'call' || use.kind === 'reference')).toBe(true);
    expect(checkAllowlist(uses, [])).not.toEqual([]);
  });

  it.each([
    "import { execFile } from 'child_process'; execFile('git', [], () => {});",
    "const documentation = `execSync('git')`; // spawnSync('git')",
    "/* import { execSync } from 'child_process'; execSync('git') */",
    "function execSync(value: string) { return value; } execSync('literal');",
    "import type { execSync } from 'child_process'; type Signature = typeof execSync;",
  ])('ignores async execution, data and unrelated local bindings: %s', (source) => {
    expect(findSyncProcessUses(source)).toEqual([]);
  });

  it('binds a waiver to exact invocation and count, not an entire file', () => {
    const source = "import { execSync } from 'child_process'; execSync('git status');";
    const uses = findSyncProcessUses(source, 'src/main/legacy.ts');
    expect(uses.length).toBeGreaterThan(0);
    const allow = uses.map((use) => ({ ...use, count: 1, reason: 'Existing bounded compatibility probe; owner runtime.' }));
    expect(checkAllowlist(uses, allow)).toEqual([]);
    expect(checkAllowlist(findSyncProcessUses(source + " execSync('git status');", 'src/main/legacy.ts'), allow)).not.toEqual([]);
    expect(checkAllowlist(findSyncProcessUses(source.replace('git status', 'git worktree add'), 'src/main/legacy.ts'), allow)).not.toEqual([]);
    expect(checkAllowlist(findSyncProcessUses(source, 'src/main/new.ts'), allow)).not.toEqual([]);
  });

  it('ignores formatting/comments when identifying an invocation', () => {
    const a = findSyncProcessUses("import {execSync} from 'child_process'; execSync('git');");
    const b = findSyncProcessUses("import { execSync } from 'child_process';\n execSync( /* note */ 'git' );");
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((use) => use.fingerprint)).toEqual(b.map((use) => use.fingerprint));
  });

  it('F-929: a CRLF checkout yields the same fingerprint as LF, even after a template substitution', () => {
    const lf = "import { spawnSync } from 'child_process';\nconst r = spawnSync(\n  'dscl',\n  [`/Users/${user}`, 'UserShell'],\n  { timeout: 2_000 },\n);\n";
    const a = findSyncProcessUses(lf);
    const b = findSyncProcessUses(lf.replaceAll('\n', '\r\n'));
    expect(a.some((use) => use.kind === 'call')).toBe(true);
    expect(b.map((use) => use.fingerprint)).toEqual(a.map((use) => use.fingerprint));
  });

  it('normalizes Windows source paths before binding imported aliases', () => {
    const uses = findSyncProcessUses("import { execSync as run } from 'child_process'; run('git');", 'src\\main\\windows.ts');
    expect(uses.some((use) => use.kind === 'call')).toBe(true);
    expect(uses.every((use) => use.file === 'src/main/windows.ts')).toBe(true);
  });

  it('requires a reason for every exception and rejects duplicates/stale waivers', () => {
    const uses = findSyncProcessUses("import { execSync } from 'child_process'; execSync('git');");
    expect(uses.length).toBeGreaterThan(0);
    const allow = uses.map((use) => ({ ...use, count: 1, reason: 'Existing bounded startup probe.' }));
    expect(checkAllowlist(uses, allow.map((entry) => ({ ...entry, reason: '' })))).not.toEqual([]);
    expect(checkAllowlist(uses, [...allow, allow[0]])).not.toEqual([]);
    expect(checkAllowlist([], allow)).not.toEqual([]);
  });

  it('tracks repeated declarations without looping and distinguishes references from their new context', () => {
    const uses = findSyncProcessUses("import {execSync, spawnSync} from 'child_process'; var run=execSync; var run=spawnSync; run('git');");
    expect(uses.length).toBeGreaterThan(0);
    const first = findSyncProcessUses("import {execSync} from 'child_process'; schedule(execSync);");
    const second = findSyncProcessUses("import {execSync} from 'child_process'; invokeImmediately(execSync);");
    expect(first.find((use) => use.kind === 'reference')?.fingerprint).not.toBe(second.find((use) => use.kind === 'reference')?.fingerprint);
  });

  it('the executable gate rejects a new use in an already allowed file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sync-lint-'));
    try {
      fs.mkdirSync(path.join(root, 'src/main'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts'));
      const source = "import { execSync } from 'child_process'; execSync('git status');";
      const file = 'src/main/legacy.ts';
      fs.writeFileSync(path.join(root, file), source);
      const uses = findSyncProcessUses(source, file);
      fs.writeFileSync(path.join(root, 'scripts/main-sync-allowlist.json'), JSON.stringify({
        version: 1,
        exceptions: uses.map((use) => ({ ...use, count: 1, reason: 'Existing fixture-only synchronous probe.' })),
      }));
      const script = fileURLToPath(new URL('./check-main-sync.mjs', import.meta.url));
      const before = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
      expect(before.status, before.stderr).toBe(0);
      fs.appendFileSync(path.join(root, file), " execSync('git worktree add');");
      const after = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
      expect(after.status).toBe(1);
      expect(after.stderr).toContain('new synchronous process');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
