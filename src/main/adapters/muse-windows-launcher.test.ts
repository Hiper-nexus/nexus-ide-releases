import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsMuseLauncherSpawn } from './muse-windows-launcher';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const VERSION = '1.4.1-R4503.1';
const LAUNCHER =
  '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ' +
  '-NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\n';

function install(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-muse-'));
  dirs.push(dir);
  const all: Record<string, string> = {
    'muse.cmd': LAUNCHER,
    '.muse-launcher.ps1': 'Invoke-Main @args',
    '.muse-version': `${VERSION}\n`,
    [`muse-bin-${VERSION}.exe`]: 'MZ',
    'muse-bin-1.3.0-R3401.1.exe': 'MZ',
    ...files,
  };
  for (const [name, content] of Object.entries(all)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

describe('Muse no Windows abre o binário ativo, não o muse.cmd (F-706)', () => {
  it('resolve o muse-bin da .muse-version, com o release info quando a versão confere', () => {
    const info = JSON.stringify({ channel: 'muse-stable', version: VERSION });
    const dir = install({ '.muse-release-info.json': info });
    expect(windowsMuseLauncherSpawn(path.join(dir, 'muse.cmd'))).toEqual({
      file: path.join(dir, `muse-bin-${VERSION}.exe`),
      argsPrefix: [],
      env: { MUSE_RELEASE_INFO: info },
    });
  });

  it('release info de outra versão não viaja', () => {
    const dir = install({ '.muse-release-info.json': JSON.stringify({ version: '1.3.0-R3401.1' }) });
    expect(windowsMuseLauncherSpawn(path.join(dir, 'muse.cmd'))?.env).toEqual({});
  });

  it('sem o launcher oficial, versão inválida ou binário ausente, fica no caminho antigo', () => {
    expect(windowsMuseLauncherSpawn(path.join(install({ 'muse.cmd': '@echo off\r\nevil.exe %*' }), 'muse.cmd')))
      .toBeNull();
    expect(windowsMuseLauncherSpawn(path.join(install({ '.muse-version': '..\\..\\x' }), 'muse.cmd'))).toBeNull();
    const dir = install();
    fs.rmSync(path.join(dir, `muse-bin-${VERSION}.exe`));
    expect(windowsMuseLauncherSpawn(path.join(dir, 'muse.cmd'))).toBeNull();
    expect(windowsMuseLauncherSpawn(path.join(install(), 'codex.cmd'))).toBeNull();
  });
});
