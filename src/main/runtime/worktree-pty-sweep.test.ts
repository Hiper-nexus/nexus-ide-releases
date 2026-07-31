import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureWorktreePtySweep,
  sessionsInsideWorktree,
  sweepPtysInsideWorktree,
} from './worktree-pty-sweep';

const ROOT = '/repo/.worktrees/mission-a';

describe('sessionsInsideWorktree', () => {
  it('claims the sessions rooted in the worktree, including its own root', () => {
    expect(
      sessionsInsideWorktree({
        worktreePath: ROOT,
        sessions: [
          { sessionId: 'raiz', cwd: ROOT },
          { sessionId: 'fundo', cwd: `${ROOT}/src/main` },
        ],
      }),
    ).toEqual(['raiz', 'fundo']);
  });

  it('never claims a sibling whose name merely starts the same', () => {
    // `/…/mission-a` não pode arrastar `/…/mission-anexo`: o prefixo textual
    // casa, o caminho não. É este o erro que mata o worktree do vizinho.
    expect(
      sessionsInsideWorktree({
        worktreePath: ROOT,
        sessions: [{ sessionId: 'vizinho', cwd: `${ROOT}nexo/src` }],
      }),
    ).toEqual([]);
  });

  it('never claims a parent or an unrelated tree', () => {
    expect(
      sessionsInsideWorktree({
        worktreePath: ROOT,
        sessions: [
          { sessionId: 'pai', cwd: '/repo/.worktrees' },
          { sessionId: 'repo', cwd: '/repo' },
          { sessionId: 'outro', cwd: '/outro/projeto' },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps a child directory named with a leading double dot', () => {
    // `..cache` é nome de diretório válido; só `..` e `../…` escapam.
    expect(
      sessionsInsideWorktree({
        worktreePath: ROOT,
        sessions: [{ sessionId: 'oculto', cwd: `${ROOT}/..cache` }],
      }),
    ).toEqual(['oculto']);
  });

  it('stays silent instead of guessing when the cwd is unknown', () => {
    // Fail-closed deliberado: matar o PTY errado perde trabalho do operador,
    // deixar um sobrando só gera aviso.
    expect(
      sessionsInsideWorktree({
        worktreePath: ROOT,
        sessions: [
          { sessionId: 'sem-cwd', cwd: null },
          { sessionId: 'cwd-vazio', cwd: '   ' },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses to sweep anything when the worktree path is blank', () => {
    // Um root vazio casaria com tudo em quase toda implementação ingênua de
    // prefixo — aqui ele não pode matar uma única sessão.
    expect(
      sessionsInsideWorktree({
        worktreePath: '   ',
        sessions: [
          { sessionId: 'a', cwd: '/repo' },
          { sessionId: 'b', cwd: ROOT },
        ],
      }),
    ).toEqual([]);
  });

  it('handles Windows paths without falling back to POSIX semantics', () => {
    const win = 'C:\\repo\\.worktrees\\mission-a';
    expect(
      sessionsInsideWorktree({
        worktreePath: win,
        sessions: [
          { sessionId: 'dentro', cwd: `${win}\\src` },
          { sessionId: 'irmao', cwd: 'C:\\repo\\.worktrees\\mission-anexo' },
        ],
      }),
    ).toEqual(['dentro']);
  });
});

describe('sweepPtysInsideWorktree', () => {
  afterEach(() => {
    configureWorktreePtySweep(null);
    vi.restoreAllMocks();
  });

  it('terminates only the sessions living inside the released worktree', () => {
    const terminate = vi.fn(async () => true);
    configureWorktreePtySweep({
      listSessions: () => [
        { sessionId: 'dentro', cwd: `${ROOT}/src` },
        { sessionId: 'vizinho', cwd: `${ROOT}nexo/src` },
        { sessionId: 'outro', cwd: '/outro' },
      ],
      terminate,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(sweepPtysInsideWorktree(ROOT)).toEqual(['dentro']);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('dentro');
  });

  it('does nothing at all until the bootstrap wires the ports', () => {
    // Sem configuração, o registry ainda chama esta função em todo release —
    // ela não pode explodir nem inventar um encerramento.
    expect(sweepPtysInsideWorktree(ROOT)).toEqual([]);
  });

  it('never lets a broken inventory break the worktree release', () => {
    configureWorktreePtySweep({
      listSessions: () => {
        throw new Error('inventário indisponível');
      },
      terminate: async () => true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => sweepPtysInsideWorktree(ROOT)).not.toThrow();
    expect(sweepPtysInsideWorktree(ROOT)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('never lets a refused termination break the worktree release', () => {
    // O release roda dentro do caminho de dispatch: uma limpeza oportunista
    // não pode derrubar o despacho da próxima missão.
    const terminate = vi.fn(() => {
      throw new Error('PTY recusou');
    });
    configureWorktreePtySweep({
      listSessions: () => [{ sessionId: 'teimoso', cwd: ROOT }],
      terminate: terminate as unknown as (id: string) => Promise<unknown>,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => sweepPtysInsideWorktree(ROOT)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('swallows an async termination rejection without an unhandled rejection', async () => {
    configureWorktreePtySweep({
      listSessions: () => [{ sessionId: 'lento', cwd: ROOT }],
      terminate: async () => {
        throw new Error('timeout físico');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(sweepPtysInsideWorktree(ROOT)).toEqual(['lento']);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });
});
