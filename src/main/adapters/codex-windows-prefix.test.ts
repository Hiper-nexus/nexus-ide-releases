import { describe, expect, it } from 'vitest';
import {
  CodexWindowsPathTooLongError,
  codexWindowsHostPath,
  codexWindowsPrefixFits,
  windowsCodexShimWithinMaxPath,
  WINDOWS_MAX_PATH_CHARS,
} from './codex-windows-prefix';

const HOME = 'C:\\Users\\Administrador';
const WINGET =
  'C:\\Users\\Administrador\\AppData\\Local\\Microsoft\\WinGet\\Packages\\' +
  'OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\\node-v22.23.2-win-x64';
const SHORT = 'C:\\Users\\Administrador\\.local\\bin';

describe('caminho do host de ferramentas do Codex no Windows (F-688)', () => {
  it('o prefixo do Node portátil do WinGet passa do MAX_PATH; o curto cabe', () => {
    // Medido em 29/09: "failed to spawn code-mode host … (os error 3)".
    expect(codexWindowsHostPath(WINGET, 'x64').length).toBeGreaterThan(WINDOWS_MAX_PATH_CHARS);
    expect(codexWindowsPrefixFits(WINGET, 'x64')).toBe(false);
    expect(codexWindowsHostPath(SHORT, 'x64').length).toBe(156);
    expect(codexWindowsPrefixFits(SHORT, 'x64')).toBe(true);
    expect(codexWindowsPrefixFits('C:\\Users\\ana\\AppData\\Roaming\\npm', 'x64')).toBe(true);
  });

  it('usa a instalação curta quando o atalho resolvido cai no prefixo longo', () => {
    const present = new Set([
      codexWindowsHostPath(WINGET, 'x64'),
      `${SHORT}\\codex.cmd`,
      codexWindowsHostPath(SHORT, 'x64'),
    ]);
    expect(
      windowsCodexShimWithinMaxPath(`${WINGET}\\codex.cmd`, {
        home: HOME,
        arch: 'x64',
        exists: (p) => present.has(p),
      }),
    ).toBe(`${SHORT}\\codex.cmd`);
  });

  it('recusa com a correção quando não há instalação curta', () => {
    const present = new Set([codexWindowsHostPath(WINGET, 'x64')]);
    const run = () =>
      windowsCodexShimWithinMaxPath(`${WINGET}\\codex.cmd`, {
        home: HOME,
        arch: 'x64',
        exists: (p) => present.has(p),
      });
    expect(run).toThrow(CodexWindowsPathTooLongError);
    expect(run).toThrow(/npm i -g --prefix "%USERPROFILE%\\\.local\\bin" @openai\/codex/u);
  });

  it('não mexe em atalho curto, em executável nativo nem em Codex sem o host', () => {
    const none = () => false;
    expect(
      windowsCodexShimWithinMaxPath(`${SHORT}\\codex.cmd`, { home: HOME, arch: 'x64', exists: () => true }),
    ).toBe(`${SHORT}\\codex.cmd`);
    expect(
      windowsCodexShimWithinMaxPath('C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe', {
        home: HOME,
        arch: 'x64',
        exists: () => true,
      }),
    ).toBe('C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe');
    // Codex anterior ao 0.157 não tem host: o prefixo longo não atrapalha.
    expect(
      windowsCodexShimWithinMaxPath(`${WINGET}\\codex.cmd`, { home: HOME, arch: 'x64', exists: none }),
    ).toBe(`${WINGET}\\codex.cmd`);
  });
});
