import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  QWEN_LOGICAL_CWD_ENV,
  QWEN_PROJECT_NAME_MAX,
  qwenLogicalCwdLaunch,
  qwenNeedsLogicalCwd,
  qwenProjectDirName,
  resetQwenLogicalCwdForTests,
} from './qwen-long-cwd';

const roots: string[] = [];
afterEach(() => {
  resetQwenLogicalCwdForTests();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-long-cwd-')));
  roots.push(root);
  // Mesmo formato da worktree de writer do Nexus: vários segmentos de 64 hex. O primeiro
  // cresce até o nome do projeto do Qwen passar de 255 com QUALQUER tmpdir: o do macOS é
  // comprido, o /tmp do Linux não (sem isso a fixture ficava em ~252 e o teste falhava).
  let lead = 64;
  let cwd = '';
  do {
    cwd = path.join(root, `project-${'a'.repeat(lead)}`, `checkout-${'b'.repeat(64)}`,
      'worktrees', `task-${'c'.repeat(64)}`);
    lead += 8;
  } while (!qwenNeedsLogicalCwd(cwd));
  const entry = path.join(root, 'qwen-code', 'cli-entry.js');
  const bin = path.join(root, 'bin', 'qwen');
  const stateHome = path.join(root, 'provider-state', 'qwen', 'checkout-1');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(entry, bin);
  return { root, cwd, entry, bin, stateHome };
}

function launchFor(fx: ReturnType<typeof fixture>, cwd = fx.cwd) {
  return qwenLogicalCwdLaunch({ binPath: fx.bin, cwd, stateHome: fx.stateHome, nodePath: process.execPath });
}

/** Roda um script no Node do teste com o preload do lançamento, como o Qwen rodaria. */
function runWithPreload(
  launch: NonNullable<ReturnType<typeof qwenLogicalCwdLaunch>>,
  cwd: string,
  script: string,
  env: Record<string, string> = { ...launch.env },
): string {
  const [requireFlag, preload] = launch.argsPrefix;
  return execFileSync(process.execPath, [requireFlag!, preload!, '-e', script], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
}

describe('Qwen com cwd longo (F-788)', () => {
  it('o nome da pasta do projeto do Qwen é o cwd inteiro com não alfanuméricos trocados', () => {
    expect(qwenProjectDirName('/Users/x/Library/Application Support/NexusIDE')).toBe(
      '-Users-x-Library-Application-Support-NexusIDE',
    );
    const fx = fixture();
    expect(qwenNeedsLogicalCwd(fx.cwd)).toBe(true);
    expect(qwenNeedsLogicalCwd(fx.root)).toBe(false);
  });

  it('cwd longo: Node + preload + entrypoint real, apelido curto e estável que aponta para a worktree', () => {
    const fx = fixture();
    const launch = launchFor(fx)!;
    expect(launch).not.toBeNull();
    expect(launch.file).toBe(process.execPath);
    expect(launch.argsPrefix).toEqual(['--require', path.join(fx.stateHome, 'nexus-logical-cwd.cjs'), fx.entry]);
    const alias = launch.env[QWEN_LOGICAL_CWD_ENV]!;
    expect(launch.env.PWD).toBe(alias);
    expect(path.dirname(alias)).toBe(fx.stateHome);
    expect(fs.readlinkSync(alias)).toBe(fx.cwd);
    expect(qwenProjectDirName(alias).length).toBeLessThanOrEqual(QWEN_PROJECT_NAME_MAX);
    // Respawn da mesma worktree reusa o mesmo apelido: o --resume acha a conversa.
    expect(launchFor(fx)).toEqual(launch);
  });

  it('o preload faz o process.cwd() responder o apelido; arquivos relativos caem na worktree física', () => {
    const fx = fixture();
    const launch = launchFor(fx)!;
    const observed = JSON.parse(runWithPreload(launch, fx.cwd,
      "const fs = require('node:fs'); fs.writeFileSync('prova.txt', 'ok');" +
      "console.log(JSON.stringify({ cwd: process.cwd(), resolved: require('node:path').resolve('x'), real: fs.realpathSync('.') }))",
    )) as { cwd: string; resolved: string; real: string };
    const alias = launch.env[QWEN_LOGICAL_CWD_ENV]!;
    expect(observed.cwd).toBe(alias);
    expect(observed.resolved).toBe(path.join(alias, 'x'));
    expect(observed.real).toBe(fx.cwd);
    expect(fs.readFileSync(path.join(fx.cwd, 'prova.txt'), 'utf8')).toBe('ok');
  });

  it('o preload é inerte fora da worktree do apelido, sem a variável e com o apelido sumido', () => {
    const fx = fixture();
    const launch = launchFor(fx)!;
    const cwdOf = (cwd: string, env?: Record<string, string>) =>
      runWithPreload(launch, cwd, 'process.stdout.write(process.cwd())', env);
    expect(cwdOf(fx.root)).toBe(fx.root);
    expect(cwdOf(fx.cwd, {})).toBe(fx.cwd);
    fs.unlinkSync(launch.env[QWEN_LOGICAL_CWD_ENV]!);
    expect(cwdOf(fx.cwd)).toBe(fx.cwd);
  });

  it('cwd curto não muda nada e não grava nada', () => {
    const fx = fixture();
    expect(launchFor(fx, fx.root)).toBeNull();
    expect(fs.existsSync(fx.stateHome)).toBe(false);
  });

  it('apelido trocado por outro alvo é refeito; entrada que não é symlink não é tocada', () => {
    const fx = fixture();
    const alias = launchFor(fx)!.env[QWEN_LOGICAL_CWD_ENV]!;
    fs.unlinkSync(alias);
    fs.symlinkSync(fx.root, alias);
    expect(launchFor(fx)?.env[QWEN_LOGICAL_CWD_ENV]).toBe(alias);
    expect(fs.readlinkSync(alias)).toBe(fx.cwd);

    fs.unlinkSync(alias);
    fs.mkdirSync(alias);
    expect(launchFor(fx)).toBeNull();
    expect(fs.statSync(alias).isDirectory()).toBe(true);
  });

  it('lançador que não é script Node ou sem Node resolvido: spawn normal', () => {
    const fx = fixture();
    const native = path.join(fx.root, 'bin', 'qwen-native');
    fs.writeFileSync(native, '', { mode: 0o755 });
    expect(qwenLogicalCwdLaunch({ binPath: native, cwd: fx.cwd, stateHome: fx.stateHome, nodePath: process.execPath })).toBeNull();
    expect(qwenLogicalCwdLaunch({ binPath: fx.bin, cwd: fx.cwd, stateHome: fx.stateHome, nodePath: null })).toBeNull();
  });
});
