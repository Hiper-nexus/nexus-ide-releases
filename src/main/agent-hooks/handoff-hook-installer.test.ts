import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanAgentsWorkspaceHooks,
  cleanCodexWorkspaceHooks,
  cleanupLegacyHandoffHooks,
  deleteLegacyHandoffHookScripts,
  removeLegacyHandoffHookRegistration,
} from './handoff-hook-installer';

const temps: string[] = [];

/** Diretório temporário usado como $HOME e/ou workspace do teste. */
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-hook-cleanup-'));
  temps.push(dir);
  return dir;
}

/** Cria um arquivo que existe no disco (executável "vivo"). */
function touch(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\n');
  return file;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeSettings(home: string, settings: unknown): void {
  writeJson(join(home, '.claude', 'settings.json'), settings);
}

function readSettings(home: string): Record<string, unknown> {
  return readJson(join(home, '.claude', 'settings.json'));
}

function codexHooksPath(workspace: string): string {
  return join(workspace, '.codex', 'hooks.json');
}

function agentsHooksPath(workspace: string): string {
  return join(workspace, '.agents', 'hooks.json');
}

/** Caminho do soft-status.mjs do Overclock, com o $HOME do teste. */
const overclockCommand = (home: string, file: string) =>
  join(home, '.overclock-app', file);

/** Stop hook no formato da 0.32.x (~/.nexus/agent-hooks/handoff-*). */
const legacyStopEntry = (home: string) => ({
  hooks: [
    {
      type: 'command',
      command: join(home, '.nexus', 'agent-hooks', 'handoff-stop.mjs'),
      timeout: 15000,
    },
    {
      type: 'command',
      command: join(home, '.nexus', 'agent-hooks', 'handoff-deliver.mjs'),
      timeout: 15000,
    },
  ],
});

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('removeLegacyHandoffHookRegistration', () => {
  it('remove os Stop hooks da 0.32.x e preserva hooks alheios', () => {
    const home = makeTemp();
    writeSettings(home, {
      hooks: {
        Stop: [
          legacyStopEntry(home),
          {
            hooks: [{ type: 'command', command: 'other-tool' }],
          },
        ],
        PreToolUse: legacyStopEntry(home),
      },
    });

    expect(removeLegacyHandoffHookRegistration(home)).toBe(true);
    const settings = readSettings(home);
    const stop = (settings.hooks as Record<string, unknown>).Stop as unknown[];
    expect(stop).toHaveLength(1);
    const kept = (stop[0] as { hooks: unknown[] }).hooks;
    expect(kept).toHaveLength(1);
    expect((kept[0] as { command: string }).command).toBe('other-tool');
    expect((settings.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
  });

  it('remove os hooks do Overclock mesmo com o script ainda no disco', () => {
    const home = makeTemp();
    // O script existe: prova que quem condena aqui é a regra do port, não a
    // do executável ausente.
    for (const file of ['soft-status.mjs', 'handoff-deliver.mjs', 'handoff-stop.mjs']) {
      touch(overclockCommand(home, file));
    }
    writeSettings(home, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: overclockCommand(home, 'soft-status.mjs') },
              { type: 'command', command: overclockCommand(home, 'handoff-deliver.mjs') },
              { type: 'command', command: overclockCommand(home, 'handoff-stop.mjs') },
            ],
          },
        ],
      },
    });

    expect(removeLegacyHandoffHookRegistration(home)).toBe(true);
    expect((readSettings(home).hooks as Record<string, unknown>).Stop).toEqual([]);
  });

  it('preserva arquivo do Overclock que não é do port', () => {
    const home = makeTemp();
    touch(overclockCommand(home, 'outra-coisa.mjs'));
    writeSettings(home, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: overclockCommand(home, 'outra-coisa.mjs') },
            ],
          },
        ],
      },
    });

    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });

  it('remove hook cujo executável não existe mais no disco', () => {
    const home = makeTemp();
    writeSettings(home, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `${home}/bin/sumiu.mjs --flag` },
            ],
          },
        ],
      },
    });

    expect(removeLegacyHandoffHookRegistration(home)).toBe(true);
    expect((readSettings(home).hooks as Record<string, unknown>).Stop).toEqual([]);
  });

  it('preserva hook cujo executável existe no disco', () => {
    const home = makeTemp();
    const keptScript = touch(join(home, 'bin', 'meu-hook.mjs'));
    writeSettings(home, {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: `${keptScript} --flag` }] },
          { hooks: [{ type: 'command', command: `"${keptScript}" --flag` }] },
        ],
      },
    });

    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });

  it('preserva comando nu — quem resolve é o PATH do shell', () => {
    const home = makeTemp();
    writeSettings(home, {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'pnpm prettier --write' }] },
          { hooks: [{ type: 'command', command: './scripts/local.sh' }] },
        ],
      },
    });

    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });

  it('é idempotente: segunda passada não reescreve', () => {
    const home = makeTemp();
    writeSettings(home, { hooks: { Stop: [legacyStopEntry(home)] } });
    expect(removeLegacyHandoffHookRegistration(home)).toBe(true);
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });

  it('settings ausente ou ilegível → false, sem lançar', () => {
    const home = makeTemp();
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json');
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });
});

describe('cleanCodexWorkspaceHooks', () => {
  it('remove o soft-status.mjs de todos os eventos e preserva o resto', () => {
    const ws = makeTemp();
    const file = codexHooksPath(ws);
    const dead = overclockCommand(ws, 'soft-status.mjs');
    writeJson(file, {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: dead, timeout: 5 }] },
          { hooks: [{ type: 'command', command: 'meu-formatador' }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: dead, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: dead, timeout: 5 }] }],
      },
    });

    expect(cleanCodexWorkspaceHooks(ws)).toBe(true);
    const hooks = readJson(file).hooks as Record<string, unknown>;
    const preToolUse = hooks.PreToolUse as { hooks: { command: string }[] }[];
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].hooks[0].command).toBe('meu-formatador');
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.Stop).toBeUndefined();
    expect(cleanCodexWorkspaceHooks(ws)).toBe(false);
  });

  it('apaga o arquivo quando não sobra hook nenhum', () => {
    const ws = makeTemp();
    const file = codexHooksPath(ws);
    writeJson(file, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(ws, 'soft-status.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
      },
    });

    expect(cleanCodexWorkspaceHooks(ws)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('preserva entrada cujo executável existe', () => {
    const ws = makeTemp();
    const file = codexHooksPath(ws);
    const alive = touch(join(ws, 'bin', 'soft-status.mjs'));
    writeJson(file, {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: alive, timeout: 5 }] }],
      },
    });

    expect(cleanCodexWorkspaceHooks(ws)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it('arquivo ausente ou json inválido → false, arquivo intocado', () => {
    const ws = makeTemp();
    expect(cleanCodexWorkspaceHooks(ws)).toBe(false);

    const file = codexHooksPath(ws);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{not json');
    expect(cleanCodexWorkspaceHooks(ws)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('cleanAgentsWorkspaceHooks', () => {
  it('remove o handoff-deliver.mjs e apaga o arquivo que ficou vazio', () => {
    const ws = makeTemp();
    const file = agentsHooksPath(ws);
    writeJson(file, {
      'overclock-handoff-deliver': {
        enabled: true,
        Stop: [
          {
            type: 'command',
            command: overclockCommand(ws, 'handoff-deliver.mjs'),
            timeout: 5,
          },
        ],
      },
    });

    expect(cleanAgentsWorkspaceHooks(ws)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('preserva os outros hooks e mantém o arquivo', () => {
    const ws = makeTemp();
    const file = agentsHooksPath(ws);
    writeJson(file, {
      'overclock-handoff-deliver': {
        enabled: true,
        Stop: [
          {
            type: 'command',
            command: overclockCommand(ws, 'handoff-deliver.mjs'),
            timeout: 5,
          },
        ],
      },
      'meu-hook': {
        enabled: true,
        PostToolUse: [{ type: 'command', command: 'meu-formatador' }],
      },
    });

    expect(cleanAgentsWorkspaceHooks(ws)).toBe(true);
    expect(Object.keys(readJson(file))).toEqual(['meu-hook']);
  });

  it('preserva entrada cujo executável existe', () => {
    const ws = makeTemp();
    const file = agentsHooksPath(ws);
    const alive = touch(join(ws, 'bin', 'handoff-deliver.mjs'));
    writeJson(file, {
      'meu-hook': {
        enabled: true,
        Stop: [{ type: 'command', command: alive, timeout: 5 }],
      },
    });

    expect(cleanAgentsWorkspaceHooks(ws)).toBe(false);
    expect(readJson(file)).toEqual({
      'meu-hook': {
        enabled: true,
        Stop: [{ type: 'command', command: alive, timeout: 5 }],
      },
    });
  });

  it('arquivo ausente ou json inválido → false', () => {
    const ws = makeTemp();
    expect(cleanAgentsWorkspaceHooks(ws)).toBe(false);

    const file = agentsHooksPath(ws);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{not json');
    expect(cleanAgentsWorkspaceHooks(ws)).toBe(false);
  });
});

describe('deleteLegacyHandoffHookScripts', () => {
  it('apaga os três arquivos legados e devolve os nomes', () => {
    const home = makeTemp();
    const dir = join(home, '.nexus', 'agent-hooks');
    mkdirSync(dir, { recursive: true });
    for (const name of ['handoff-stop.mjs', 'handoff-deliver.mjs', 'soft-status.mjs']) {
      writeFileSync(join(dir, name), 'legacy');
    }
    expect(deleteLegacyHandoffHookScripts(home)).toEqual([
      'handoff-stop.mjs',
      'handoff-deliver.mjs',
      'soft-status.mjs',
    ]);
    expect(deleteLegacyHandoffHookScripts(home)).toEqual([]);
  });

  it('não apaga arquivos vizinhos (kimi-mcp-bridge)', () => {
    const home = makeTemp();
    const dir = join(home, '.nexus', 'agent-hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'handoff-stop.mjs'), 'legacy');
    writeFileSync(join(dir, 'kimi-mcp-bridge.mjs'), 'fica');
    deleteLegacyHandoffHookScripts(home);
    expect(readFileSync(join(dir, 'kimi-mcp-bridge.mjs'), 'utf8')).toBe('fica');
  });
});

describe('cleanupLegacyHandoffHooks', () => {
  it('uma chamada limpa os três alvos e nunca lança', () => {
    const root = makeTemp();
    writeSettings(root, { hooks: { Stop: [legacyStopEntry(root)] } });

    const codexFile = codexHooksPath(root);
    writeJson(codexFile, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(root, 'soft-status.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
      },
    });

    const agentsFile = agentsHooksPath(root);
    writeJson(agentsFile, {
      'overclock-handoff-deliver': {
        enabled: true,
        Stop: [
          {
            type: 'command',
            command: overclockCommand(root, 'handoff-deliver.mjs'),
            timeout: 5,
          },
        ],
      },
    });

    const dir = join(root, '.nexus', 'agent-hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'handoff-stop.mjs'), 'legacy');

    const result = cleanupLegacyHandoffHooks(root, root);
    expect(result.unregistered).toBe(true);
    expect(result.deleted).toEqual(['handoff-stop.mjs']);
    expect(result.cleaned).toEqual([codexFile, agentsFile]);
    expect(existsSync(codexFile)).toBe(false);
    expect(existsSync(agentsFile)).toBe(false);

    expect(cleanupLegacyHandoffHooks(root, root)).toEqual({
      unregistered: false,
      deleted: [],
      cleaned: [],
    });
  });

  it('workspace sem nada para limpar → no-op', () => {
    const root = makeTemp();
    expect(cleanupLegacyHandoffHooks(root, root)).toEqual({
      unregistered: false,
      deleted: [],
      cleaned: [],
    });
  });
});
