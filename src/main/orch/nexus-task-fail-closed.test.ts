import { describe, expect, it } from 'vitest';
import {
  civilianNexusTaskFailMessage,
  decideNexusTaskFailClosed,
  extractObjectiveFolder,
  inferRoleOwnershipFiles,
  plannedRolesFromNexusTaskArgs,
} from './nexus-task-fail-closed';
import { attemptQueuedRoleSpawns } from './nexus-task-fail-closed-recovery';

describe('nexus_task fail-closed (fan-out não fica Na fila)', () => {
  const planned = [
    {
      roleId: 'ux',
      roleName: 'UX Designer',
      category: 'reviewer',
      files: ['saas-waitlist-3/DESIGN.md'],
    },
    {
      roleId: 'backend',
      roleName: 'Backend',
      category: 'executor',
      files: ['saas-waitlist-3/server.js'],
    },
    {
      roleId: 'generalist',
      roleName: 'Generalist',
      category: 'executor',
      files: ['saas-waitlist-3/package.json'],
    },
  ] as const;

  it('falha de nexus_task com outros papéis planejados não os deixa na fila sem tentativa de spawn', () => {
    const decision = decideNexusTaskFailClosed({
      missionStatus: 'running',
      nexusTaskFailed: true,
      plannedRoles: planned,
      spawnedRoleIds: ['ux'],
      spawnedRoleNames: ['UX Designer'],
    });
    expect(decision.action).toBe('retry-unspawned');
    if (decision.action !== 'retry-unspawned') return;
    expect(decision.unspawned.map((role) => role.roleName)).toEqual([
      'Backend',
      'Generalist',
    ]);
    expect(decision.toast).toMatch(/plano da equipe falhou/i);
    expect(decision.toast).toMatch(/Backend/);
    expect(decision.toast).toMatch(/Generalist/);
    expect(decision.toast).not.toMatch(/nexus_task|mcp__/i);
  });

  it('tenta spawn de cada papel planejado que ficou na fila', async () => {
    const attempted: string[] = [];
    const result = await attemptQueuedRoleSpawns({
      roles: planned.filter((role) => role.roleId !== 'ux'),
      roster: [
        { id: 'backend', agentName: 'Backend', category: 'executor', cli: 'codex' },
        { id: 'generalist', agentName: 'Generalist', category: 'executor', cli: 'kimi' },
        { id: 'claude-dev', agentName: 'Claude Dev', category: 'executor', cli: 'claude' },
      ],
      spawn: async (role) => {
        attempted.push(`${role.roleName}:${role.adapterId}:${role.files.join(',')}`);
        return { ok: true, paneId: `pane-${role.roleId}` };
      },
    });
    expect(attempted).toHaveLength(2);
    expect(attempted[0]).toMatch(/^Backend:codex:saas-waitlist-3\/server\.js$/);
    expect(attempted[1]).toMatch(/^Generalist:kimi:saas-waitlist-3\/package\.json$/);
    expect(result.attemptedRoleIds).toEqual(['backend', 'generalist']);
    expect(result.spawnedRoleIds).toEqual(['backend', 'generalist']);
    expect(result.queuedWithoutSpawn).toEqual([]);
  });

  it('reroteia CLI morta no retry e não deixa o papel na fila', async () => {
    const attempted: string[] = [];
    const result = await attemptQueuedRoleSpawns({
      roles: [
        {
          roleId: 'backend',
          roleName: 'Backend',
          category: 'executor',
          files: ['saas-waitlist-3/server.js'],
        },
      ],
      roster: [
        { id: 'backend', agentName: 'Backend', category: 'executor', cli: 'kimi' },
        { id: 'claude-dev', agentName: 'Claude Dev', category: 'executor', cli: 'claude' },
      ],
      spawn: async (role) => {
        attempted.push(role.adapterId);
        if (role.adapterId === 'kimi') {
          return { ok: false, error: 'pane spawn failed: ENOENT binary' };
        }
        return { ok: true, paneId: 'pane-claude' };
      },
    });
    expect(attempted).toEqual(['kimi', 'claude']);
    expect(result.spawnedRoleIds).toEqual(['backend']);
    expect(result.queuedWithoutSpawn).toEqual([]);
    expect(result.rerouteNote).toMatch(/não iniciou/i);
  });

  it('sem falha de nexus_task não reabre papéis', () => {
    expect(
      decideNexusTaskFailClosed({
        missionStatus: 'running',
        nexusTaskFailed: false,
        plannedRoles: planned,
        spawnedRoleIds: ['ux'],
      }),
    ).toEqual({ action: 'none' });
  });

  it('quando todos os planejados já nasceram, não retry', () => {
    expect(
      decideNexusTaskFailClosed({
        missionStatus: 'running',
        nexusTaskFailed: true,
        plannedRoles: planned,
        spawnedRoleIds: ['ux', 'backend', 'generalist'],
        spawnedRoleNames: ['UX Designer', 'Backend', 'Generalist'],
      }),
    ).toEqual({ action: 'none' });
  });

  it('extrai papéis do nexus_task plan e infere files disjuntos', () => {
    const roles = plannedRolesFromNexusTaskArgs({
      action: 'plan',
      tasks: [
        {
          id: 't-ux',
          title: 'Design',
          agentRef: 'ux',
          agentName: 'UX Designer',
          category: 'reviewer',
          detail: 'Escreva saas-waitlist-3/DESIGN.md',
        },
        {
          id: 't-back',
          title: 'API',
          agentRef: 'backend',
          agentName: 'Backend',
          ownership: { files: ['saas-waitlist-3/server.js'] },
        },
      ],
    });
    expect(roles).toHaveLength(2);
    expect(roles[0]?.files).toContain('saas-waitlist-3/DESIGN.md');
    expect(roles[1]?.files).toContain('saas-waitlist-3/server.js');
  });

  it('infere pasta do objetivo e files por papel', () => {
    expect(extractObjectiveFolder('Crie saas-waitlist-3 com landing')).toBe(
      'saas-waitlist-3',
    );
    expect(
      inferRoleOwnershipFiles({
        roleName: 'Backend',
        objective: 'Crie saas-waitlist-3',
      }),
    ).toEqual(['saas-waitlist-3/server.js']);
    expect(
      inferRoleOwnershipFiles({
        roleName: 'UX Designer',
        objective: 'Crie saas-waitlist-3',
      }),
    ).toEqual(['saas-waitlist-3/DESIGN.md']);
  });

  it('mensagem civil em PT sem jargão de tool', () => {
    expect(
      civilianNexusTaskFailMessage({ queuedRoleNames: ['Backend'] }),
    ).toMatch(/Backend agora/);
    expect(
      civilianNexusTaskFailMessage({ queuedRoleNames: [] }),
    ).toMatch(/reabrir os papéis/i);
  });
});
