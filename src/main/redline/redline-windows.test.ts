import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installRedlineWin,
  isRedlineRunningWin,
  openRedlineWin,
  parseTasklistCsv,
  readWindowsAutostart,
  redlineExeNeedsReplace,
  resolveInstalledRedlineExe,
  resolveWindowsInstallDir,
  setWindowsAutostart,
  syncInstalledRedlineWin,
  type WinDeps,
} from './redline-windows';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RecordedCall {
  file: string;
  args: readonly string[];
}

function fakeExec(responses: Record<string, string>, calls: RecordedCall[]) {
  return (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const key = `${file} ${args[0]}`;
    if (!(key in responses)) throw new Error(`exit 1: ${key}`);
    return { stdout: responses[key] };
  };
}

/** Bundle embutido falso (exe + provider-logos, como o build monta). */
function fakeBundle(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'redline-win-bundle-'));
  roots.push(root);
  writeFileSync(path.join(root, 'NexusRedline.exe'), `exe-${version}`);
  mkdirSync(path.join(root, 'provider-logos'), { recursive: true });
  writeFileSync(path.join(root, 'provider-logos', 'manifest.json'), '{}');
  return path.join(root, 'NexusRedline.exe');
}

function winDeps(extra?: Partial<WinDeps>): WinDeps {
  const calls: RecordedCall[] = [];
  let localAppData = extra?.localAppData;
  if (!localAppData && !extra?.installDir) {
    localAppData = mkdtempSync(path.join(tmpdir(), 'redline-win-home-'));
    roots.push(localAppData);
  }
  return {
    platform: 'win32',
    localAppData,
    execFile: fakeExec({}, calls),
    spawnDetached: () => {},
    ...extra,
  };
}

describe('parseTasklistCsv', () => {
  it('acha o exe no CSV sem header', () => {
    expect(
      parseTasklistCsv(
        '"NexusRedline.exe","1234","Console","1","10.304 K"\r\n',
      ),
    ).toBe(true);
  });

  it('INFO sem tarefa não é match', () => {
    expect(parseTasklistCsv('INFO: No tasks are running\r\n')).toBe(false);
    expect(parseTasklistCsv('')).toBe(false);
  });
});

describe('isRedlineRunningWin', () => {
  it('usa tasklist com argv fixo e lê o CSV', () => {
    const calls: RecordedCall[] = [];
    const deps = winDeps({
      execFile: fakeExec(
        { 'tasklist /FI': '"NexusRedline.exe","9","Console","1","1 K"' },
        calls,
      ),
    });
    expect(isRedlineRunningWin(deps)).toBe(true);
    expect(calls[0].args).toEqual([
      '/FI',
      'IMAGENAME eq NexusRedline.exe',
      '/FO',
      'CSV',
      '/NH',
    ]);
  });

  it('falha fechada quando o tasklist erra', () => {
    expect(isRedlineRunningWin(winDeps())).toBe(false);
  });
});

describe('autostart HKCU', () => {
  const exe = 'C:\\Users\\op\\AppData\\Local\\NexusRedline\\NexusRedline.exe';

  it('lê o valor exato entre aspas', () => {
    const deps = winDeps({
      execFile: fakeExec(
        {
          'reg query':
            `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    NexusRedline    REG_SZ    "${exe}"\r\n`,
        },
        [],
      ),
    });
    expect(readWindowsAutostart(exe, deps)).toBe(true);
    expect(readWindowsAutostart('C:\\outro\\x.exe', deps)).toBe(false);
  });

  it('grava com argv fixo e aspas no /d', () => {
    const calls: RecordedCall[] = [];
    const deps = winDeps({
      execFile: fakeExec({ 'reg add': '', 'schtasks /Create': '' }, calls),
    });
    expect(setWindowsAutostart(true, exe, deps)).toBe(true);
    expect(calls.some((c) => c.file === 'schtasks' && c.args[0] === '/Create')).toBe(true);
    expect(calls.find((c) => c.file === 'schtasks')?.args).toEqual([
      '/Create',
      '/F',
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      '/TN',
      'NexusRedline',
      '/TR',
      `"${exe}"`,
    ]);
    expect(calls[0]).toEqual({
      file: 'reg',
      args: [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        'NexusRedline',
        '/t',
        'REG_SZ',
        '/d',
        `"${exe}"`,
        '/f',
      ],
    });
  });

  it('remover valor ausente é ok sem chamar delete', () => {
    const calls: RecordedCall[] = [];
    const deps = winDeps({
      execFile: (file, args) => {
        calls.push({ file, args });
        throw new Error('exit 1');
      },
    });
    expect(setWindowsAutostart(false, exe, deps)).toBe(true);
    // schtasks /Delete (ausente é ok) e o query do Run.
    expect(calls.map((c) => `${c.file} ${c.args[0]}`)).toEqual([
      'schtasks /Delete',
      'reg query',
    ]);
  });
});

describe('redlineExeNeedsReplace', () => {
  it('é true quando os bytes diferem e false quando iguais', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'redline-win-exe-'));
    roots.push(dir);
    const a = path.join(dir, 'a.exe');
    const b = path.join(dir, 'b.exe');
    writeFileSync(a, 'v1');
    writeFileSync(b, 'v2');
    expect(redlineExeNeedsReplace(a, b)).toBe(true);
    writeFileSync(b, 'v1');
    expect(redlineExeNeedsReplace(a, b)).toBe(false);
    expect(redlineExeNeedsReplace(a, path.join(dir, 'falta.exe'))).toBe(true);
  });
});

describe('installRedlineWin', () => {
  it('recusa fora do Windows', () => {
    const result = installRedlineWin(undefined, true, {
      ...winDeps(),
      platform: 'linux',
    });
    expect(result.ok).toBe(false);
  });

  it('copia o bundle inteiro e abre o instalado com --first-run', () => {
    const launched: Array<{ target: string; args?: readonly string[] }> = [];
    const calls: RecordedCall[] = [];
    const bundled = fakeBundle('v2');
    const deps = winDeps({
      bundledExe: bundled,
      execFile: fakeExec({}, calls), // tasklist vazio: não está rodando
      spawnDetached: (target, args) => launched.push({ target, args }),
    });
    const result = installRedlineWin(undefined, true, deps);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/bandeja/);
    const installed = resolveInstalledRedlineExe(deps);
    expect(installed).toBe(
      path.join(resolveWindowsInstallDir(deps), 'NexusRedline.exe'),
    );
    // O balão aponta o overflow só na primeira execução pós-instalação.
    expect(launched).toEqual([{ target: installed, args: ['--first-run'] }]);
  });

  it('sem bundle não instala nada', () => {
    const launched: string[] = [];
    const deps = winDeps({
      bundledExe: null,
      spawnDetached: (target) => launched.push(target),
    });
    const result = installRedlineWin(undefined, true, deps);
    expect(result.ok).toBe(false);
    expect(launched).toEqual([]);
    expect(resolveInstalledRedlineExe(deps)).toBe(null);
  });
});

describe('openRedlineWin', () => {
  it('abre o instalado sem balão e reinicia quando já roda', () => {
    const launched: Array<{ target: string; args?: readonly string[] }> = [];
    const calls: RecordedCall[] = [];
    const bundled = fakeBundle('v1');
    const deps = winDeps({
      bundledExe: bundled,
      execFile: fakeExec(
        { 'tasklist /FI': '"NexusRedline.exe","9","Console","1","1 K"' },
        calls,
      ),
      spawnDetached: (target, args) => launched.push({ target, args }),
    });
    // Primeiro instala para existir um instalado.
    const installCalls: RecordedCall[] = [];
    const installDeps = winDeps({
      bundledExe: bundled,
      localAppData: deps.localAppData,
      installDir: deps.installDir,
      execFile: fakeExec({}, installCalls),
      spawnDetached: () => {},
    });
    expect(installRedlineWin(undefined, true, installDeps).ok).toBe(true);
    const result = openRedlineWin(undefined, true, deps);
    expect(result.ok).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0].args ?? []).toEqual(['--open-panel']);
    // taskkill foi chamado para reiniciar (stop antes do open).
    expect(calls.some((c) => c.file === 'taskkill')).toBe(true);
  });
});

describe('openRedlineWin ordering', () => {
  it('espera o anterior morrer antes de relançar (corrida do mutex)', () => {
    const order: string[] = [];
    const tasklistRuns = [
      '"NexusRedline.exe","9","Console","1","1 K"',
      '"NexusRedline.exe","9","Console","1","1 K"',
      'INFO: No tasks are running',
    ];
    const bundled = fakeBundle('v1');
    const installDeps = winDeps({
      bundledExe: bundled,
      execFile: fakeExec({}, []),
      spawnDetached: () => {},
    });
    expect(installRedlineWin(undefined, true, installDeps).ok).toBe(true);
    const deps = winDeps({
      bundledExe: bundled,
      localAppData: installDeps.localAppData,
      execFile: (file, args) => {
        order.push(`${file} ${args[0]}`);
        if (file === 'tasklist') return { stdout: tasklistRuns.shift() ?? '' };
        return { stdout: '' };
      },
      spawnDetached: (_target, args) => {
        order.push(`spawn ${(args ?? []).join(' ')}`);
      },
    });
    const result = openRedlineWin(undefined, true, deps);
    expect(result.ok).toBe(true);
    // taskkill sai e o tasklist é sondado até esvaziar ANTES do spawn.
    expect(order[0]).toBe('tasklist /FI');
    expect(order).toContain('taskkill /IM');
    const killIdx = order.indexOf('taskkill /IM');
    const spawnIdx = order.findIndex((e) => e.startsWith('spawn '));
    expect(spawnIdx).toBeGreaterThan(killIdx);
    expect(order.slice(killIdx, spawnIdx).filter((e) => e === 'tasklist /FI').length).toBeGreaterThanOrEqual(1);
    expect(order[spawnIdx]).toBe('spawn --open-panel');
  });
});

describe('syncInstalledRedlineWin', () => {
  it('não instala sem consentimento quando falta o instalado', async () => {
    const launched: string[] = [];
    const deps = winDeps({
      bundledExe: fakeBundle('v1'),
      spawnDetached: (target) => launched.push(target),
    });
    await syncInstalledRedlineWin(undefined, true, deps);
    expect(launched).toEqual([]);
  });

  it('substitui build diferente e relança quando parado', async () => {
    const launched: string[] = [];
    const installCalls: RecordedCall[] = [];
    const installDeps = winDeps({
      bundledExe: fakeBundle('v1'),
      execFile: fakeExec({}, installCalls),
      spawnDetached: () => {},
    });
    expect(installRedlineWin(undefined, true, installDeps).ok).toBe(true);
    const deps = winDeps({
      bundledExe: fakeBundle('v2'),
      localAppData: installDeps.localAppData,
      execFile: fakeExec({}, []),
      spawnDetached: (target) => launched.push(target),
    });
    await syncInstalledRedlineWin(undefined, true, deps);
    expect(launched).toHaveLength(1);
  });
});
