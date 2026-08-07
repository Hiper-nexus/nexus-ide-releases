/**
 * P1-4 — `missionId` chegava como texto livre do renderer em memory:remember e
 * autonomy:decide, sem charset, sem existência e sem conferir contra o escopo
 * do sender. Mesmo modelo de autoridade que memory-ipc.ts documenta: o escopo
 * vem do ProjectExecutionScope autorizado do sender, nunca de argumento do
 * renderer — e agora a IDENTIDADE DA MISSÃO segue a mesma regra.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../shared/types';

// Hermético: o módulo importa 'electron'; nada aqui toca ipcMain/BrowserWindow.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const missionsByScope = new Map<string, Set<string>>();

vi.mock('./orch/project-domain-store-registry', () => ({
  getProjectDomainStores: (scope: ProjectExecutionScope) => ({
    missions: {
      get: (id: string) =>
        missionsByScope.get(scope.projectId)?.has(id)
          ? { id, title: 'm' }
          : null,
    },
  }),
}));

function scopeFor(projectId: string): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'i',
    projectId,
    checkoutId: 'c',
    rootRealPath: `/tmp/${projectId}`,
    identitySource: 'manifest',
  } as ProjectExecutionScope;
}

afterEach(() => {
  missionsByScope.clear();
  vi.restoreAllMocks();
});

describe('authorizedMissionAttribution (memory:remember, autonomy:decide)', () => {
  it('devolve undefined quando o chamador não reivindica missão', async () => {
    const { authorizedMissionAttribution } = await import(
      './product-wave-ipc'
    );
    await expect(
      authorizedMissionAttribution(scopeFor('p1'), undefined),
    ).resolves.toBeUndefined();
  });

  it('aceita o id só quando a missão existe NO escopo do sender', async () => {
    missionsByScope.set('p1', new Set(['mission-lz4k2p-3']));
    const { authorizedMissionAttribution } = await import(
      './product-wave-ipc'
    );

    await expect(
      authorizedMissionAttribution(scopeFor('p1'), 'mission-lz4k2p-3'),
    ).resolves.toBe('mission-lz4k2p-3');
  });

  it('recusa missão viva de OUTRO workspace', async () => {
    missionsByScope.set('p2', new Set(['mission-lz4k2p-3']));
    const { authorizedMissionAttribution } = await import(
      './product-wave-ipc'
    );

    await expect(
      authorizedMissionAttribution(scopeFor('p1'), 'mission-lz4k2p-3'),
    ).rejects.toThrow(/mission_id_unauthorized/);
  });

  it('recusa missão inexistente em vez de inventar atribuição', async () => {
    missionsByScope.set('p1', new Set(['mission-outra']));
    const { authorizedMissionAttribution } = await import(
      './product-wave-ipc'
    );

    await expect(
      authorizedMissionAttribution(scopeFor('p1'), 'mission-lz4k2p-3'),
    ).rejects.toThrow(/mission_id_unauthorized/);
  });

  it('recusa charset inseguro antes de qualquer lookup', async () => {
    missionsByScope.set('p1', new Set(['../x', 'a/b', 'Mission-A']));
    const { authorizedMissionAttribution } = await import(
      './product-wave-ipc'
    );

    for (const forged of ['../x', 'a/b', 'Mission-A', 'a:b', '']) {
      await expect(
        authorizedMissionAttribution(scopeFor('p1'), forged),
      ).rejects.toThrow(/mission_id_unsafe/);
    }
  });
});

describe('operatorMemorySource — o source não é escolhido pelo chamador', () => {
  it('deriva o source de missão só de um id já autorizado', async () => {
    const { operatorMemorySource } = await import('./product-wave-ipc');
    expect(operatorMemorySource('mission', 'mission-lz4k2p-3')).toBe(
      'operator:mission:mission-lz4k2p-3',
    );
  });

  it('não fabrica missão "manual" quando nenhuma foi autorizada', async () => {
    const { operatorMemorySource } = await import('./product-wave-ipc');
    // `operator:mission:manual` promovia a nota a kind=mission — entrando na
    // busca de missões sob um id que não existe em lugar nenhum.
    expect(() => operatorMemorySource('mission', undefined)).toThrow(
      /mission_id_required/,
    );
  });

  it('mantém agent e note fora do namespace de missão', async () => {
    const { operatorMemorySource } = await import('./product-wave-ipc');
    expect(operatorMemorySource('agent', undefined)).toBe(
      'operator:agent:manual',
    );
    expect(operatorMemorySource('note', undefined)).toBe('operator:note');
    // Nem mesmo com um id autorizado em mãos: só kind=mission atribui missão.
    expect(operatorMemorySource('note', 'mission-lz4k2p-3')).toBe(
      'operator:note',
    );
  });
});
