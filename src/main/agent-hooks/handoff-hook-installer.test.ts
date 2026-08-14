import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupLegacyHandoffHooks,
  deleteLegacyHandoffHookScripts,
  removeLegacyHandoffHookRegistration,
} from './handoff-hook-installer';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-hook-cleanup-'));
}

function writeSettings(home: string, settings: unknown): void {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(home, '.claude', 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
}

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

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('removeLegacyHandoffHookRegistration', () => {
  it('remove os Stop hooks da 0.32.x e preserva hooks alheios', () => {
    const home = makeHome();
    homes.push(home);
    writeSettings(home, {
      hooks: {
        Stop: [
          legacyStopEntry(home),
          {
            hooks: [
              { type: 'command', command: '/usr/local/bin/other-tool' },
            ],
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
    expect((kept[0] as { command: string }).command).toBe('/usr/local/bin/other-tool');
    expect((settings.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
  });

  it('é idempotente: segunda passada não reescreve', () => {
    const home = makeHome();
    homes.push(home);
    writeSettings(home, { hooks: { Stop: [legacyStopEntry(home)] } });
    expect(removeLegacyHandoffHookRegistration(home)).toBe(true);
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });

  it('settings ausente ou ilegível → false, sem lançar', () => {
    const home = makeHome();
    homes.push(home);
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json');
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });

  it('não remove hooks que não apontam para .nexus/agent-hooks/handoff-', () => {
    const home = makeHome();
    homes.push(home);
    writeSettings(home, {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: '~/.overclock-app/handoff-stop.mjs' }],
          },
        ],
      },
    });
    expect(removeLegacyHandoffHookRegistration(home)).toBe(false);
  });
});

describe('deleteLegacyHandoffHookScripts', () => {
  it('apaga os três arquivos legados e devolve os nomes', () => {
    const home = makeHome();
    homes.push(home);
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
    const home = makeHome();
    homes.push(home);
    const dir = join(home, '.nexus', 'agent-hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'handoff-stop.mjs'), 'legacy');
    writeFileSync(join(dir, 'kimi-mcp-bridge.mjs'), 'fica');
    deleteLegacyHandoffHookScripts(home);
    expect(readFileSync(join(dir, 'kimi-mcp-bridge.mjs'), 'utf8')).toBe('fica');
  });
});

describe('cleanupLegacyHandoffHooks', () => {
  it('uma chamada faz as duas limpezas e nunca lança', () => {
    const home = makeHome();
    homes.push(home);
    writeSettings(home, { hooks: { Stop: [legacyStopEntry(home)] } });
    const dir = join(home, '.nexus', 'agent-hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'handoff-stop.mjs'), 'legacy');

    const result = cleanupLegacyHandoffHooks(home);
    expect(result.unregistered).toBe(true);
    expect(result.deleted).toEqual(['handoff-stop.mjs']);
    expect(cleanupLegacyHandoffHooks(home)).toEqual({
      unregistered: false,
      deleted: [],
    });
  });
});
