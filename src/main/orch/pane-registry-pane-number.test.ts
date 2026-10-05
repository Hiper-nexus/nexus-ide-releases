import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { PaneRegistryEntry } from '../../shared/orch-types';

/**
 * O NÚMERO do pane como endereço no protocolo MCP.
 *
 * O que estes testes travam: o número é ADIÇÃO. `nexus_pane_list` publica o
 * número E o id, mirar pelo número atinge o MESMO pane que mirar pelo id, e
 * nenhuma ambiguidade vira chute — porque mandar trabalho para o terminal
 * errado é o único erro que não tem desfazer.
 */

const pty = vi.hoisted(() => ({
  live: new Set<string>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: vi.fn((sessionId: string) =>
    pty.live.has(sessionId) ? 'idle' : null,
  ),
  isSessionOwnedBy: vi.fn((_owner: WebContents, sessionId: string) =>
    pty.live.has(sessionId),
  ),
  getAgentSessionInfo: vi.fn(() => null),
  getOwnedAgentSessionInfo: vi.fn(() => null),
  listAgentSessionsForPane: vi.fn(() => []),
  orchKillSession: vi.fn(() => true),
  orchTerminateSession: vi.fn(async () => true),
  orchWriteSession: vi.fn(() => true),
  detachOwnedMissionAgentSession: vi.fn(() => true),
  spawnMainOwnedAgentSession: vi.fn(),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

import {
  getPaneAuthzInfo,
  listLivePaneNumbers,
  listPaneSnapshots,
  syncPanes,
  attachOrchMeta,
} from './pane-registry';
import {
  deleteMainOwnedPane,
  setMainOwnedPane,
} from './main-owned-pane-runtime';
import { mintToken, bindTokenToSession, releaseSession } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

function owner(id: number): WebContents {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    isCrashed: () => false,
  } as unknown as WebContents;
}

function entry(
  paneId: string,
  paneNumber: number | undefined,
  sessionId: string | null = null,
): PaneRegistryEntry {
  return {
    paneId,
    sessionId,
    paneNumber,
    title: paneId,
    kind: 'cli-agent',
  };
}

const renderer = owner(1);

describe('nexus_pane_list publica o número junto do id', () => {
  beforeEach(() => {
    pty.live.clear();
    syncPanes([], renderer, 'gen-reset');
  });

  it('uses the main-issued executionScope for authz instead of stale pane metadata', () => {
    const scope = testProjectScope();
    const executionScope = { ...scope, rootRealPath: '/worktree/actual' };
    const ctx = mintToken({ label: 'isolated', role: 'worker', missionId: 'm', scope, executionScope });
    bindTokenToSession(ctx.token, 'isolated-session');
    pty.live.add('isolated-session');
    try {
      syncPanes([entry('isolated-pane', 3, 'isolated-session')], renderer, 'isolated-gen');
      attachOrchMeta(renderer, 'isolated-pane', { missionId: 'm', role: 'worker', scope,
        executionScope: { ...scope, rootRealPath: '/worktree/stale' }, allowedTools: null, allowedSkills: null });
      expect(getPaneAuthzInfo('isolated-pane')?.executionScope).toEqual(executionScope);
    } finally {
      releaseSession('isolated-session');
    }
  });

  it('cada pane listado carrega paneId E paneNumber', () => {
    syncPanes(
      [entry('pane-a1b2c3d4', 1), entry('pane-e5f6a7b8', 2)],
      renderer,
      'gen-1',
    );
    const listed = listPaneSnapshots();
    expect(listed).toHaveLength(2);
    expect(listed.map((pane) => ({ id: pane.paneId, n: pane.paneNumber }))).toEqual([
      { id: 'pane-a1b2c3d4', n: 1 },
      { id: 'pane-e5f6a7b8', n: 2 },
    ]);
  });

  it('listLivePaneNumbers nomeia os números válidos, ordenados e sem repetição', () => {
    syncPanes(
      [entry('pane-a', 4), entry('pane-b', 1), entry('pane-c', undefined)],
      renderer,
      'gen-2',
    );
    expect(listLivePaneNumbers()).toEqual([1, 4]);
  });
});

describe('mirar pelo número atinge o mesmo pane que mirar pelo id', () => {
  beforeEach(() => {
    pty.live.clear();
    syncPanes([], renderer, 'gen-reset');
    syncPanes(
      [entry('pane-a1b2c3d4', 1), entry('pane-e5f6a7b8', 7)],
      renderer,
      'gen-3',
    );
  });

  it('"7", "pane 7" e "pane sete" resolvem para o mesmo pane que o id', () => {
    const byId = getPaneAuthzInfo('pane-e5f6a7b8');
    expect(byId?.paneId).toBe('pane-e5f6a7b8');
    for (const ref of ['7', '#7', 'pane 7', 'pane-7', 'no pane 7', 'pane sete']) {
      expect(getPaneAuthzInfo(ref)?.paneId).toBe(byId?.paneId);
    }
  });

  it('o id continua sendo aceito — o número não substitui o protocolo', () => {
    expect(getPaneAuthzInfo('pane-a1b2c3d4')?.paneId).toBe('pane-a1b2c3d4');
  });

  it('número inexistente não resolve (a recusa nomeia os válidos)', () => {
    expect(getPaneAuthzInfo('pane 9')).toBeNull();
    expect(listLivePaneNumbers()).toEqual([1, 7]);
  });

  it('número duplicado entre janelas é ambiguidade, nunca um chute', () => {
    const segundaJanela = owner(2);
    pty.live.clear();
    syncPanes([entry('pane-outra-janela', 7)], segundaJanela, 'gen-w2');
    // Dois panes vivos com o número 7 → recusa, e o id de cada um segue exato.
    expect(getPaneAuthzInfo('pane 7')).toBeNull();
    expect(getPaneAuthzInfo('pane-e5f6a7b8')?.paneId).toBe('pane-e5f6a7b8');
    expect(getPaneAuthzInfo('pane-outra-janela')?.paneId).toBe('pane-outra-janela');
    syncPanes([], segundaJanela, 'gen-w2-clear');
  });

  it('id só de dígitos vence a leitura numérica — identidade primeiro', () => {
    // ~2% dos ids saem só com dígitos; lê-los como número entregaria o pane
    // errado. Aqui o id "7" e o NÚMERO 7 apontam para panes diferentes.
    syncPanes([], renderer, 'gen-reset-2');
    syncPanes([entry('7', 5), entry('pane-real', 7)], renderer, 'gen-4');
    expect(getPaneAuthzInfo('7')?.paneId).toBe('7');
    expect(getPaneAuthzInfo('pane 7')?.paneId).toBe('pane-real');
  });
});

describe('F-925: o mesmo pane nos dois registros não é ambiguidade', () => {
  beforeEach(() => {
    pty.live.clear();
    syncPanes([], renderer, 'gen-reset');
  });

  it('duplicata renderer+main-owned resolve para um e o close não diz "unknown pane"', () => {
    // Campo 05/10: nexus_pane_close("pane-muv26zi7-1b") devolvia "unknown
    // pane" enquanto a própria mensagem listava o pane vivo. O pane estava no
    // espelho do renderer E no registro main-owned (adoção sem remoção) —
    // 2 matches do MESMO id viravam null no `length === 1` antigo.
    const paneId = 'pane-muv26zi7-1b';
    const sessionId = 'session-agy-idle';
    pty.live.add(sessionId);
    try {
      syncPanes([entry(paneId, 3, sessionId)], renderer, 'gen-dup');
      setMainOwnedPane(paneId, {
        entry: {
          paneId,
          sessionId,
          title: 'agy',
          kind: 'cli-agent',
          adapterId: 'agy',
          state: 'idle',
        },
        meta: {
          missionId: 'mission-a',
          role: 'worker',
          scope: testProjectScope(),
        },
      });
      // O inventário lista o pane vivo…
      const alive = listPaneSnapshots().filter((p) => p.paneId === paneId);
      expect(alive.length).toBeGreaterThanOrEqual(1);
      // …e a resolução acha o MESMO pane em vez de "unknown pane".
      const info = getPaneAuthzInfo(paneId);
      expect(info?.paneId).toBe(paneId);
      expect(info?.sessionId).toBe(sessionId);
    } finally {
      deleteMainOwnedPane(paneId);
    }
  });

  it('panes DIFERENTES com o mesmo sessionId continuam ambiguidade', () => {
    const sessionId = 'session-shared';
    pty.live.add(sessionId);
    try {
      syncPanes([entry('pane-left', 1, sessionId)], renderer, 'gen-amb');
      syncPanes([entry('pane-right', 2, sessionId)], owner(2), 'gen-amb2');
      expect(getPaneAuthzInfo(sessionId)).toBeNull();
    } finally {
      syncPanes([], renderer, 'gen-amb-clear');
      syncPanes([], owner(2), 'gen-amb2-clear');
    }
  });
});
