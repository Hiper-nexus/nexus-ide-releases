import { describe, expect, it } from 'vitest';
import type { AdapterInfo } from '../../shared/adapter-types';
import {
  assertClosedAcyclicPlanDependencies,
  assertSealedTaskSchedule,
  resolveSealedWorkerRoute,
  supportsMechanicallyReadOnlyCli,
  supportsMechanicallyWorkspaceWriteCli,
} from './mission-scheduler-plan';

function adapter(
  id: string,
  installed: boolean,
  models: string[],
  defaultModel: string,
): AdapterInfo {
  return {
    id,
    installed,
    kind: id === 'omp' ? 'cli-rpc' : 'cli-pty',
    label: id,
    icon: id,
    models: { list: models, default: defaultModel },
    installCommand: '',
    idleTimeoutMs: 60_000,
    orchestratorCapable: true,
  };
}

describe('sealed scheduler roster contract', () => {
  it('advertises read-only only for CLIs with an enforced native boundary', () => {
    expect(supportsMechanicallyReadOnlyCli('codex')).toBe(true);
    expect(supportsMechanicallyReadOnlyCli('glm')).toBe(false);
    expect(supportsMechanicallyReadOnlyCli('longcat')).toBe(false);
    expect(supportsMechanicallyReadOnlyCli('omp')).toBe(false);
    expect(supportsMechanicallyReadOnlyCli('agy')).toBe(false);
    expect(supportsMechanicallyReadOnlyCli('grok')).toBe(false);
  });
  it('admits only Codex for sealed autonomous workspace writes', () => {
    expect(supportsMechanicallyWorkspaceWriteCli('codex')).toBe(true);
    for (const adapterId of [
      'kimi',
      'omp',
      'opencode',
      'agy',
      'grok',
      'glm',
      'longcat',
    ]) {
      expect(
        supportsMechanicallyWorkspaceWriteCli(adapterId),
        adapterId,
      ).toBe(false);
    }
  });
  it('honours the exact roster CLI even when another installed provider is first', () => {
    const route = resolveSealedWorkerRoute({
      taskText: 'Implementar o endpoint e os testes',
      rosterHash: 'a'.repeat(64),
      agent: {
        id: 'frontend', agentName: 'Frontend', category: 'executor',
        cli: 'agy', model: 'gemini-3.6-flash-high', effort: 'medium',
        allowedTools: ['nexus_handoff_submit'],
      },
      adapters: [
        adapter('codex', true, ['gpt-5.6-sol'], 'gpt-5.6-sol'),
        adapter('agy', true, ['gemini-3.6-flash-high'], 'gemini-3.6-flash-high'),
      ],
    });

    expect(route).toMatchObject({
      routeContract: {
        adapterId: 'agy', model: 'gemini-3.6-flash-high', effort: 'medium',
      },
      decision: { adapterId: 'agy', alternatives: [] },
    });
  });

  it('resolves a configured model family to the real CLI variant', () => {
    const route = resolveSealedWorkerRoute({
      taskText: 'Refatorar o scheduler',
      rosterHash: 'b'.repeat(64),
      agent: {
        id: 'backend', agentName: 'Backend', category: 'executor',
        cli: 'codex', model: 'gpt-5.6', effort: 'high',
      },
      adapters: [adapter(
        'codex', true, ['gpt-5.6-sol', 'gpt-5.6-terra'], 'gpt-5.6-sol',
      )],
    });

    expect(route.routeContract.model).toBe('gpt-5.6-sol');
  });

  it('fails closed instead of substituting a provider or unrelated model', () => {
    const agent = {
      id: 'reviewer', agentName: 'Reviewer', category: 'reviewer' as const,
      cli: 'agy', model: 'gemini-3.1-pro-high', effort: 'high',
    };
    expect(() => resolveSealedWorkerRoute({
      taskText: 'Revisar o patch', rosterHash: 'c'.repeat(64), agent,
      adapters: [adapter('codex', true, ['gpt-5.6-sol'], 'gpt-5.6-sol')],
    })).toThrow(/nenhum provider substituto/i);
    expect(() => resolveSealedWorkerRoute({
      taskText: 'Revisar o patch', rosterHash: 'c'.repeat(64), agent,
      adapters: [adapter('agy', true, ['gemini-3.6-flash-low'], 'gemini-3.6-flash-low')],
    })).toThrow(/modelo.*não existe/i);
  });

  it('preserves reserveClaude for every non-orchestrator roster worker', () => {
    expect(() => resolveSealedWorkerRoute({
      taskText: 'Implementar a correção', rosterHash: 'd'.repeat(64),
      agent: {
        id: 'claude-worker', agentName: 'Claude Worker', category: 'executor',
        cli: 'claude', model: 'claude-sonnet-5',
      },
      adapters: [adapter('claude', true, ['claude-sonnet-5'], 'claude-sonnet-5')],
    })).toThrow(/reserveClaude/i);
  });

  it('rejects mutable schedule metadata that diverges from the sealed agent', () => {
    const detail = 'NEXUS_SCHEDULE_META:{}\n---\nbody';
    const planned = {
      plannerId: 'task-1',
      taskId: 'task-1', agentRef: 'backend', agentCategory: 'executor' as const,
      plannedTitle: 'Task', plannedDetail: detail,
      task: {
        id: 'task-1', missionId: 'mission-1', title: 'Task', detail,
        status: 'pending' as const, createdAt: 1, updatedAt: 1,
        projectId: 'project', checkoutId: 'checkout',
      },
    };
    expect(() => assertSealedTaskSchedule(planned, {
      agentRef: 'other', agentCategory: 'reviewer', executionMode: 'read_only',
      dependsOn: [], ownership: { files: [], symbols: [], domains: [] }, merged: false,
    })).toThrow(/agente\/categoria/i);
  });

  it.each(['executor', 'architect'] as const)(
    'admits a sealed read-only %s through the runtime pre-spawn contract',
    (agentCategory) => {
      const detail = 'NEXUS_SCHEDULE_META:{}\n---\nbody';
      const planned = {
        plannerId: `task-${agentCategory}`,
        taskId: `task-${agentCategory}`,
        agentRef: `agent-${agentCategory}`,
        agentCategory,
        plannedTitle: 'Advisory',
        plannedDetail: detail,
        task: {
          id: `task-${agentCategory}`,
          missionId: 'mission-1',
          title: 'Advisory',
          detail,
          status: 'pending' as const,
          createdAt: 1,
          updatedAt: 1,
          projectId: 'project',
          checkoutId: 'checkout',
        },
      };

      expect(() =>
        assertSealedTaskSchedule(planned, {
          agentRef: `agent-${agentCategory}`,
          agentCategory,
          executionMode: 'read_only',
          dependsOn: [],
          ownership: {
            files: ['src'],
            symbols: [],
            domains: ['guided-advisory', 'sequential-only'],
          },
          merged: false,
        }),
      ).not.toThrow();
    },
  );

  it('accepts only a closed acyclic task dependency graph', () => {
    expect(() => assertClosedAcyclicPlanDependencies([
      { id: 'inspect', dependsOn: [] },
      { id: 'implement', dependsOn: ['inspect'] },
      { id: 'review', dependsOn: ['implement'] },
    ])).not.toThrow();
    expect(() => assertClosedAcyclicPlanDependencies([
      { id: 'implement', dependsOn: ['missing'] },
    ])).toThrow(/depends on unknown task missing/i);
    expect(() => assertClosedAcyclicPlanDependencies([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ])).toThrow(/dependency cycle/i);
  });
});
