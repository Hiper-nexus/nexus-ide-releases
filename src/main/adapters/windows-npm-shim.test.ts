import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsCliProbeLaunch, windowsNpmShimInvocation, windowsNpmShimSpawn, windowsNpmShimTarget } from './windows-npm-shim';

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

// Atalho gerado pelo npm 10 para o Claude Code (cópia do PC do operador, 28/09).
const CLAUDE_NPM_SHIM =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\n' +
  'CALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

describe('spawn direto por trás do .cmd do npm (F-668)', () => {
  function npmPrefix(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-npm-prefix-'));
    roots.push(root);
    return root;
  }

  it('o claude.cmd vira claude.exe: o brief multi-linha não passa pelo cmd.exe', () => {
    // Campo 28/09 13:37: o cmd.exe cortou o argumento na 1ª quebra de linha e
    // o worker recebeu só "## Nexus execution authority".
    const prefix = npmPrefix();
    const packageRoot = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
    const exe = path.join(packageRoot, 'bin', 'claude.exe');
    fs.writeFileSync(exe, '');
    const shim = path.join(prefix, 'claude.cmd');
    fs.writeFileSync(shim, CLAUDE_NPM_SHIM);
    expect(windowsNpmShimSpawn('claude', shim)).toEqual({ file: exe, argsPrefix: [] });
    // Pacote que não é o da CLI: nada de palpite.
    expect(windowsNpmShimSpawn('codex', shim)).toBeNull();
    expect(windowsNpmShimSpawn('claude', path.join(prefix, 'claude.exe'))).toBeNull();
  });

  (process.platform === 'win32' ? it : it.skip)(
    'codex num prefixo sem node.exe (ex. ~/.local/bin) usa o node do PATH',
    () => {
      const prefix = npmPrefix();
      const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex');
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }));
      const entry = path.join(packageRoot, 'bin', 'codex.js');
      fs.writeFileSync(entry, '');
      const shim = path.join(prefix, 'codex.cmd');
      fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
      const launch = windowsNpmShimSpawn('codex', shim);
      expect(launch?.argsPrefix).toEqual([entry]);
      expect(launch?.file).toMatch(/node\.exe$/iu);
      expect(fs.existsSync(launch!.file)).toBe(true);
    },
  );
});

describe('sonda curta de CLI no Windows (F-1507)', () => {
  it.runIf(process.platform === 'win32')('.exe vai direto; .cmd não verificado vai ao cmd.exe com o caminho entre aspas', () => {
    const prefix = path.join('C:\\Users\\Ana Maria', 'npm');
    expect(windowsCliProbeLaunch('kimi', path.join(prefix, 'kimi.exe'), ['provider', 'list'])).toEqual({
      file: path.join(prefix, 'kimi.exe'),
      args: ['provider', 'list'],
    });
    const launch = windowsCliProbeLaunch('kimi', path.join(prefix, 'missing-kimi.cmd'), ['provider', 'list', '--json']);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args).toEqual([
      '/d', '/s', '/c', `""${path.join(prefix, 'missing-kimi.cmd')}" provider list --json"`,
    ]);
  });

  it('atalho do npm verificado não passa pelo cmd.exe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-shim-'));
    roots.push(root);
    const packageRoot = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
    const exe = path.join(packageRoot, 'bin', 'claude.exe');
    fs.writeFileSync(exe, '');
    const shim = path.join(root, 'claude.cmd');
    fs.writeFileSync(shim, CLAUDE_NPM_SHIM);
    expect(windowsCliProbeLaunch('claude', shim, ['--version'])).toEqual({ file: exe, args: ['--version'] });
  });
});
