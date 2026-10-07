import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ on: vi.fn(), trace: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { on: hoisted.on } }));
vi.mock('../observability/main-trace', () => ({ trace: hoisted.trace }));

import { GitCommandError, ProcessGitRunner } from './git-command';
import { guardGitFailures, isGitOperationalFailure, onIpcGuarded } from './git-ipc-guard';

function gitFailure(code: string): GitCommandError {
  return new GitCommandError(
    'Git process could not complete',
    ['rev-parse', '--show-toplevel'],
    {},
    Object.assign(new Error(`spawnSync git ${code}`), { code }),
  );
}

describe('falha de git num listener de IPC', () => {
  beforeEach(() => {
    hoisted.on.mockReset();
    hoisted.trace.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconhece só GitCommandError como falha operacional de git', () => {
    expect(isGitOperationalFailure(gitFailure('ETIMEDOUT'))).toBe(true);
    expect(isGitOperationalFailure(new TypeError('bug de programação'))).toBe(false);
  });

  it('erro que não é de git continua propagando (bug não é engolido)', () => {
    const guarded = guardGitFailures('pane:sync', () => {
      throw new TypeError('bug de programação');
    });
    expect(() => guarded()).toThrow(TypeError);
    expect(hoisted.trace).not.toHaveBeenCalled();
  });

  it('GitCommandError vira registro no trace e o listener termina sem derrubar o processo', () => {
    const guarded = guardGitFailures('pane:sync', () => {
      throw gitFailure('ETIMEDOUT');
    });
    expect(() => guarded()).not.toThrow();
    expect(hoisted.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git-ipc-failure',
        where: 'pane:sync',
        subcommand: 'rev-parse',
        reason: 'ETIMEDOUT',
      }),
    );
  });

  it('onIpcGuarded registra o canal com o listener protegido', () => {
    const inner = vi.fn(() => {
      throw gitFailure('ENOBUFS');
    });
    onIpcGuarded('orch:panes-sync', inner);
    const [channel, registered] = hoisted.on.mock.calls[0]!;
    expect(channel).toBe('orch:panes-sync');
    expect(() => registered({}, 'payload')).not.toThrow();
    expect(inner).toHaveBeenCalledWith({}, 'payload');
  });

  it.skipIf(process.platform === 'win32')(
    'git que estoura o prazo de verdade (processo travado) não derruba o listener',
    () => {
      // Reproduz o caso do Mac: um `git` que não termina dentro do prazo do
      // spawnSync. O processo é morto e o erro chega como GitCommandError.
      const dir = mkdtempSync(path.join(os.tmpdir(), 'git-ipc-slow-'));
      try {
        const fakeGit = path.join(dir, 'git');
        writeFileSync(fakeGit, '#!/bin/sh\nsleep 5\n');
        chmodSync(fakeGit, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
        try {
          const guarded = guardGitFailures('pane:sync', () => {
            new ProcessGitRunner().run(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 200 });
          });
          expect(() => guarded()).not.toThrow();
          expect(hoisted.trace).toHaveBeenCalledWith(
            expect.objectContaining({ subcommand: 'rev-parse', reason: 'ETIMEDOUT' }),
          );
        } finally {
          process.env.PATH = previousPath;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
