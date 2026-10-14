import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCliBinary } from '../path-resolver';
import { peekKimiSeatReadiness, rememberKimiSeatReadiness } from './seat-auth-readiness';
import { refreshKimiSeatReadiness } from './kimi-seat-probe';

vi.mock('../path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-resolver')>();
  return { ...actual, resolveCliBinary: vi.fn(actual.resolveCliBinary) };
});

const roots: string[] = [];

afterEach(async () => {
  rememberKimiSeatReadiness(undefined);
  const actual = await vi.importActual<typeof import('../path-resolver')>('../path-resolver');
  vi.mocked(resolveCliBinary).mockImplementation(actual.resolveCliBinary);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('refreshKimiSeatReadiness', () => {
  it('source=oauth é present e vence stale missing', async () => {
    rememberKimiSeatReadiness('missing');
    const readiness = await refreshKimiSeatReadiness({
      execProviderList: async () => ({
        stdout: JSON.stringify({ providers: [{ source: 'oauth' }] }),
        stderr: 'No providers configured',
      }),
    });
    expect(readiness).toBe('present');
    expect(peekKimiSeatReadiness()).toBe('present');
  });

  it('list fresco "No providers configured" atualiza o cache', async () => {
    rememberKimiSeatReadiness('present');
    const readiness = await refreshKimiSeatReadiness({
      execProviderList: async () => ({
        stdout: 'No providers configured',
        stderr: '',
      }),
    });
    expect(readiness).toBe('missing');
  });

  it('ENOENT é missing; outro erro é unreadable', async () => {
    const missing = await refreshKimiSeatReadiness({
      execProviderList: async () => {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      },
    });
    expect(missing).toBe('missing');

    rememberKimiSeatReadiness(undefined);
    const unreadable = await refreshKimiSeatReadiness({
      execProviderList: async () => {
        throw new Error('timeout');
      },
    });
    expect(unreadable).toBe('unreadable');
  });

  // F-1507: o `shell: true` do Node junta caminho e argv com espaço, sem aspas;
  // com o npm em `C:\Users\Ana Maria\…` o cmd.exe procurava `C:\Users\Ana` e a
  // sonda virava `unreadable` → "[missing-credential] kimi: rode `kimi login`".
  describe.runIf(process.platform === 'win32')('caminho com espaço no Windows (F-1507)', () => {
    function prefixWithSpace(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kimi-probe-'));
      roots.push(root);
      const prefix = path.join(root, 'Ana Maria', 'npm');
      fs.mkdirSync(prefix, { recursive: true });
      return prefix;
    }

    function useKimi(binPath: string): void {
      vi.mocked(resolveCliBinary).mockImplementation((command) =>
        command === 'kimi'
          ? ({ binPath } as ReturnType<typeof resolveCliBinary>)
          : command === 'node'
            ? ({ binPath: process.execPath } as ReturnType<typeof resolveCliBinary>)
            : null);
    }

    it('atalho do npm verificado roda o pacote pelo node, sem cmd.exe', async () => {
      const prefix = prefixWithSpace();
      const packageRoot = path.join(prefix, 'node_modules', '@moonshot-ai', 'kimi-code');
      fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { kimi: 'dist/main.mjs' } }));
      fs.writeFileSync(
        path.join(packageRoot, 'dist', 'main.mjs'),
        "if (process.argv.slice(2).join(' ') === 'provider list --json') console.log(JSON.stringify({ providers: [{ source: 'oauth' }] }));\n",
      );
      const shim = path.join(prefix, 'kimi.cmd');
      // Atalho do npm 10 para o @moonshot-ai/kimi-code (cópia deste PC, 13/10).
      fs.writeFileSync(shim, [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs" %*',
        '',
      ].join('\r\n'));
      useKimi(shim);

      await expect(refreshKimiSeatReadiness()).resolves.toBe('present');
    });

    it('atalho .cmd não verificado vai ao cmd.exe com o caminho entre aspas', async () => {
      const prefix = prefixWithSpace();
      const shim = path.join(prefix, 'kimi.cmd');
      fs.writeFileSync(shim, '@echo off\r\necho {"providers":[{"source":"oauth"}]}\r\n');
      useKimi(shim);

      await expect(refreshKimiSeatReadiness()).resolves.toBe('present');
    });
  });
});
