import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { windowsHookEndpointLoadLines, writeHooksJson } from './installer-utils';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('writeHooksJson permissions', () => {
  it('creates the config with private permissions', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.claude', 'settings.json');

    writeHooksJson(configPath, { hooks: {} });

    expect(modeOf(configPath)).toBe(0o600);
  });

  it('preserves a more restrictive existing mode for config and backup', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.claude', 'settings.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(configPath, '{"hooks":{}}\n');
    chmodSync(configPath, 0o400);

    writeHooksJson(configPath, { hooks: { Stop: [] } });

    expect(modeOf(configPath)).toBe(0o400);
    expect(modeOf(`${configPath}.bak`)).toBe(0o400);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('{"hooks":{}}\n');
  });

  it('tightens a permissive existing mode for config and backup', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.codex', 'hooks.json');
    mkdirSync(join(root, '.codex'));
    writeFileSync(configPath, '{"hooks":{}}\n');
    chmodSync(configPath, 0o644);

    writeHooksJson(configPath, { hooks: { Stop: [] } });

    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(`${configPath}.bak`)).toBe(0o600);
  });

  it('tightens an unchanged config and an existing backup', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.claude', 'settings.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(configPath, '{\n  "hooks": {}\n}\n');
    writeFileSync(`${configPath}.bak`, 'private backup\n');
    chmodSync(configPath, 0o644);
    chmodSync(`${configPath}.bak`, 0o400);

    writeHooksJson(configPath, { hooks: {} });

    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(`${configPath}.bak`)).toBe(0o400);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('private backup\n');
  });
});

describe('windowsHookEndpointLoadLines (F-745)', () => {
  /** Script mínimo: as linhas do endpoint + um código que diz o que carregou. */
  function runHookScript(endpoint: { name: string; body: string } | null) {
    root = mkdtempSync(join(tmpdir(), 'nexus-hook-cmd-'));
    const script = join(root, 'hook.cmd');
    writeFileSync(
      script,
      [
        '@echo off',
        'setlocal',
        ...windowsHookEndpointLoadLines(),
        'if "%NEXUS_AGENT_HOOK_PORT%"=="" exit /b 0',
        'if "%NEXUS_AGENT_HOOK_PORT%:%NEXUS_AGENT_HOOK_TOKEN%"=="4242:tok" exit /b 3',
        'exit /b 9',
        '',
      ].join('\r\n'),
    );
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.NEXUS_AGENT_HOOK_ENDPOINT;
    delete env.NEXUS_AGENT_HOOK_PORT;
    delete env.NEXUS_AGENT_HOOK_TOKEN;
    if (endpoint) {
      const file = join(root, endpoint.name);
      writeFileSync(file, endpoint.body);
      env.NEXUS_AGENT_HOOK_ENDPOINT = file;
    }
    return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${script}"`], {
      env,
      input: '{}',
      windowsVerbatimArguments: true,
      encoding: 'latin1',
    });
  }

  it('pula o bloco do endpoint sem parseá-lo quando a variável não existe', () => {
    const lines = windowsHookEndpointLoadLines();
    expect(lines[0]).toBe('if not defined NEXUS_AGENT_HOOK_ENDPOINT goto nexus_hook_post');
    expect(lines.at(-1)).toBe(':nexus_hook_post');
  });

  it.runIf(process.platform === 'win32')(
    'fora de um pane do Nexus o hook sai 0, sem "A sintaxe do comando está incorreta"',
    () => {
      const result = runHookScript(null);
      expect(result.stderr.trim()).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'com o endpoint .cmd ou o arquivo `export` carrega porta e token como antes',
    () => {
      const fromCmd = runHookScript({
        name: 'endpoint.cmd',
        body: '@echo off\r\nset "NEXUS_AGENT_HOOK_PORT=4242"\r\nset "NEXUS_AGENT_HOOK_TOKEN=tok"\r\n',
      });
      expect(fromCmd.status).toBe(3);
      rmSync(root, { recursive: true, force: true });
      const fromEnv = runHookScript({
        name: 'endpoint.env',
        body: "export NEXUS_AGENT_HOOK_PORT='4242'\nexport NEXUS_AGENT_HOOK_TOKEN='tok'\n",
      });
      expect(fromEnv.status).toBe(3);
    },
  );
});
