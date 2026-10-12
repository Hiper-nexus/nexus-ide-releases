import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import { nestedWorktreeExecution, requestedCwdInside } from './nested-worktree-execution';

let temp: string;
let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-nested-worktree-')));
  root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, '-c', 'user.name=Nexus', '-c', 'user.email=nexus@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('F-981: cwd numa worktree Git aninhada', () => {
  it('a raiz (ou uma pasta) de outra worktree ligada vira escopo de execução próprio', async () => {
    const nested = path.join(root, '.harvest', 'w1');
    git(root, 'worktree', 'add', '-q', '-b', 'harvest/w1', nested);
    fs.mkdirSync(path.join(nested, 'src'));
    const scope = testProjectScope({ rootRealPath: root });
    const atRoot = await nestedWorktreeExecution(scope, nested);
    expect(atRoot?.scope).toMatchObject({ projectId: scope.projectId, checkoutId: scope.checkoutId, rootRealPath: nested });
    expect(atRoot?.cwd).toBe(nested);
    expect(Object.isFrozen(atRoot?.scope)).toBe(true);
    const inside = await nestedWorktreeExecution(scope, '.harvest/w1/src');
    expect(inside).toMatchObject({ scope: { rootRealPath: nested }, cwd: path.join(nested, 'src') });
  });

  it('pasta comum do checkout, fora do workspace, inexistente ou outro repositório não contam', async () => {
    const scope = testProjectScope({ rootRealPath: root });
    fs.mkdirSync(path.join(root, 'sub'));
    const vendored = path.join(root, 'vendor', 'lib');
    fs.mkdirSync(vendored, { recursive: true });
    git(vendored, 'init', '-q');
    const outside = path.join(temp, 'outside');
    git(root, 'worktree', 'add', '-q', '-b', 'outside', outside);
    for (const cwd of [undefined, root, 'sub', vendored, outside, 'missing']) {
      expect(await nestedWorktreeExecution(scope, cwd)).toBeUndefined();
    }
  });

  it('requestedCwdInside honra pasta do checkout e recusa dizendo que o cwd foi descartado', () => {
    fs.mkdirSync(path.join(root, 'sub'));
    expect(requestedCwdInside(root, undefined)).toBeUndefined();
    expect(requestedCwdInside(root, root)).toBe(root);
    expect(requestedCwdInside(root, 'sub')).toBe(path.join(root, 'sub'));
    expect(() => requestedCwdInside(root, path.join(temp, 'outside'))).toThrow(/cwd descartado.*isolatedWriter:true/);
    // F-1254: a saída sugerida tem de funcionar — worktree ligada DENTRO do checkout.
    const message = (() => { try { requestedCwdInside(root, path.join(temp, 'outside')); } catch (e) { return String(e); } return ''; })();
    expect(message).toContain(path.join(root, '.harvest', '<nome>'));
    expect(message).toContain('Worktree fora do checkout não vira cwd de pane');
    expect(message).not.toMatch(/nem a raiz de outra worktree/);
    expect(() => requestedCwdInside(root, 'missing')).toThrow(/cwd descartado/);
  });
});
