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
  cleanHomeHooksConfigs,
  cleanRegisteredWorkspaceHooks,
  cleanWorkspaceHookConfigs,
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

/** <dir>/.codex/hooks.json no formato do Codex com o soft-status morto. */
function deadCodexFile(file: string, dir: string, event: string): void {
  writeJson(file, {
    hooks: {
      [event]: [
        {
          hooks: [
            {
              type: 'command',
              command: overclockCommand(dir, 'soft-status.mjs'),
              timeout: 5,
            },
          ],
        },
      ],
    },
  });
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

describe('cleanHomeHooksConfigs', () => {
  const homeCodex = (home: string) => join(home, '.codex', 'hooks.json');
  const homeGrok = (home: string) => join(home, '.grok', 'hooks.json');
  const homeKimi = (home: string) => join(home, '.kimi-code', 'hooks.json');
  const grokHookFile = (home: string, name: string) =>
    join(home, '.grok', 'hooks', name);

  it('limpa o hooks.json do $HOME do Codex e apaga o arquivo vazio', () => {
    const home = makeTemp();
    const file = homeCodex(home);
    writeJson(file, {
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'soft-status.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'soft-status.mjs'),
                timeout: 30,
              },
            ],
          },
        ],
      },
    });

    expect(cleanHomeHooksConfigs(home)).toEqual([file]);
    expect(existsSync(file)).toBe(false);
    expect(cleanHomeHooksConfigs(home)).toEqual([]);
  });

  it('preserva no $HOME do Codex o hook de outro produto e o do usuário', () => {
    const home = makeTemp();
    const file = homeCodex(home);
    // Assinatura real do instalador do Nexus (`codex-hook-service.ts`): o
    // comando é um `if` de shell, não um caminho — nunca é julgado.
    const managed = {
      type: 'command',
      command:
        "if [ -x '/Users/x/.nexus/agent-hooks/codex-hook.sh' ]; then /bin/sh '/Users/x/.nexus/agent-hooks/codex-hook.sh'; fi",
      timeout: 10,
    };
    writeJson(file, {
      hooks: {
        PostToolUse: [
          { matcher: '', hooks: [managed] },
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'soft-status.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint' }] }],
      },
    });

    expect(cleanHomeHooksConfigs(home)).toEqual([file]);
    const hooks = readJson(file).hooks as Record<string, unknown[]>;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect((hooks.PostToolUse[0] as { hooks: unknown[] }).hooks).toEqual([
      managed,
    ]);
    expect((hooks.Stop[0] as { hooks: unknown[] }).hooks).toEqual([
      { type: 'command', command: 'pnpm lint' },
    ]);
  });

  it('não remove comando cujo executável existe (Codex $HOME)', () => {
    const home = makeTemp();
    const file = homeCodex(home);
    const alive = touch(join(home, 'bin', 'soft-status.mjs'));
    const doc = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: alive }] }],
      },
    };
    writeJson(file, doc);

    expect(cleanHomeHooksConfigs(home)).toEqual([]);
    expect(readJson(file)).toEqual(doc);
  });

  it('limpa o hooks.json do $HOME do Grok', () => {
    const home = makeTemp();
    const file = homeGrok(home);
    writeJson(file, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'handoff-deliver.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
      },
    });

    expect(cleanHomeHooksConfigs(home)).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  it('limpa o hooks.json do $HOME do Kimi', () => {
    const home = makeTemp();
    const file = homeKimi(home);
    writeJson(file, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'soft-status.mjs'),
              },
            ],
          },
        ],
      },
    });

    expect(cleanHomeHooksConfigs(home)).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  it('varre ~/.grok/hooks/*.json sem presumir o formato do arquivo', () => {
    const home = makeTemp();
    const dead = grokHookFile(home, 'soft-status.json');
    // Formato próprio do Grok: um hook por arquivo, comando solto no topo.
    writeJson(dead, {
      event: 'PostToolUse',
      command: overclockCommand(home, 'soft-status.mjs'),
      timeout: 5,
    });
    // Aninhamento no formato do Codex também sai, venha de onde vier.
    const deadWindows = grokHookFile(home, 'handoff.json');
    writeJson(deadWindows, {
      hooks: [
        {
          hooks: [
            {
              type: 'command',
              command: overclockCommand(home, 'handoff-stop.mjs'),
            },
          ],
        },
      ],
    });
    const alive = grokHookFile(home, 'meu-hook.json');
    const aliveCommand = `"${touch(join(home, 'bin', 'meu hook.sh'))}"`;
    writeJson(alive, { event: 'Stop', command: aliveCommand });

    const cleaned = cleanHomeHooksConfigs(home);
    // Ordem do readdir não é contrato — o conjunto é.
    expect([...cleaned].sort()).toEqual([dead, deadWindows].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(deadWindows)).toBe(false);
    // Arquivo cujo executável existe fica byte a byte igual.
    expect(readJson(alive)).toEqual({ event: 'Stop', command: aliveCommand });
  });

  it('não apaga vizinho não-json de ~/.grok/hooks', () => {
    const home = makeTemp();
    const dir = join(home, '.grok', 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'soft-status.json.bak'), 'backup');
    expect(cleanHomeHooksConfigs(home)).toEqual([]);
    expect(readFileSync(join(dir, 'soft-status.json.bak'), 'utf8')).toBe(
      'backup',
    );
  });

  it('$HOME sem esses configs ou com json inválido → no-op, sem lançar', () => {
    const home = makeTemp();
    expect(cleanHomeHooksConfigs(home)).toEqual([]);

    const file = homeCodex(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{not json');
    expect(cleanHomeHooksConfigs(home)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('cleanWorkspaceHookConfigs', () => {
  it('limpa os dois configs de UMA pasta e é idempotente', () => {
    const ws = makeTemp();
    const codexFile = codexHooksPath(ws);
    const agentsFile = agentsHooksPath(ws);
    deadCodexFile(codexFile, ws, 'Iniciativa');
    writeJson(agentsFile, {
      'overclock-soft-status': {
        enabled: true,
        PostToolUse: [
          {
            type: 'command',
            command: join(ws, '.nexus', 'agent-hooks', 'soft-status.mjs'),
          },
        ],
      },
    });

    expect(cleanWorkspaceHookConfigs(ws)).toEqual([codexFile, agentsFile]);
    expect(existsSync(codexFile)).toBe(false);
    expect(existsSync(agentsFile)).toBe(false);
    expect(cleanWorkspaceHookConfigs(ws)).toEqual([]);
  });
});

describe('cleanRegisteredWorkspaceHooks', () => {
  it('limpa os dois workspaces em tmp e ignora pasta fora da lista', () => {
    const a = makeTemp();
    const b = makeTemp();
    const decoy = makeTemp();
    const codexA = codexHooksPath(a);
    const codexB = codexHooksPath(b);
    const agentsB = agentsHooksPath(b);
    deadCodexFile(codexA, a, 'Iniciativa');
    deadCodexFile(codexB, b, 'Iniciativa');
    deadCodexFile(agentsHooksPath(decoy), decoy, 'Iniciativa');
    writeJson(agentsB, {
      'overclock-soft-status': {
        enabled: true,
        Stop: [
          {
            type: 'command',
            command: overclockCommand(b, 'soft-status.mjs'),
          },
        ],
      },
    });

    // Nenhum dos caminhos vem de process.cwd(): quem manda é a lista.
    expect(cleanRegisteredWorkspaceHooks([a, b])).toEqual([
      codexA,
      codexB,
      agentsB,
    ]);
    expect(existsSync(codexA)).toBe(false);
    expect(existsSync(codexB)).toBe(false);
    expect(existsSync(agentsB)).toBe(false);
    // Pasta registrada só na cabeça de quem chamou continua intocada.
    expect(existsSync(agentsHooksPath(decoy))).toBe(true);
  });

  it('caminho repetido não limpa duas vezes e vazio não explode', () => {
    const ws = makeTemp();
    const file = codexHooksPath(ws);
    deadCodexFile(file, ws, 'Iniciativa');

    expect(cleanRegisteredWorkspaceHooks(['', ws, ws, ''])).toEqual([file]);
    expect(cleanRegisteredWorkspaceHooks([ws, ws])).toEqual([]);
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

  it('limpa o $HOME das outras CLIs, não só o workspace', () => {
    const home = makeTemp();
    const ws = makeTemp();
    const codexHome = join(home, '.codex', 'hooks.json');
    writeJson(codexHome, {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'soft-status.mjs'),
                timeout: 5,
              },
            ],
          },
        ],
      },
    });
    const grokHome = join(home, '.grok', 'hooks.json');
    writeJson(grokHome, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: overclockCommand(home, 'soft-status.mjs'),
              },
            ],
          },
        ],
      },
    });

    const result = cleanupLegacyHandoffHooks(home, ws);
    expect(result.cleaned).toEqual([codexHome, grokHome]);
    expect(existsSync(codexHome)).toBe(false);
    expect(existsSync(grokHome)).toBe(false);

    expect(cleanupLegacyHandoffHooks(home, ws)).toEqual({
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
