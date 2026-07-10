import { describe, expect, it } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  attenuateSkills,
  attenuateTools,
  childMissionId,
} from './tools-panes';

function context(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'parent-token',
    label: 'parent',
    role: 'orchestrator',
    missionId: 'mission-a',
    scope: testProjectScope(),
    allowedTools: ['nexus_file_read', 'nexus_git_status'],
    allowedSkills: ['Review'],
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

describe('nested agent authority attenuation', () => {
  it('never grants a tool that the parent does not hold', () => {
    expect(
      attenuateTools(
        ['nexus_file_read', 'git_status'],
        ['file_read', 'nexus_terminal_run', 'nexus_git_status'],
      ),
    ).toEqual(['file_read', 'nexus_git_status']);
  });

  it('copies a limited parent allowlist when the child requests unrestricted access', () => {
    const parent = ['nexus_file_read'];
    const child = attenuateTools(parent, null);

    expect(child).toEqual(parent);
    expect(child).not.toBe(parent);
  });

  it('lets an unrestricted parent deliberately constrain its child', () => {
    expect(attenuateTools(null, ['nexus_file_read'])).toEqual([
      'nexus_file_read',
    ]);
    expect(attenuateSkills(null, ['review'])).toEqual(['review']);
  });

  it('matches skill capabilities case-insensitively', () => {
    expect(attenuateSkills(['Review'], ['review', 'deploy'])).toEqual(['review']);
  });

  it('forces descendants to remain in the parent mission', () => {
    const parent = context();

    expect(childMissionId(parent)).toBe('mission-a');
    expect(() => childMissionId(parent, 'mission-b')).toThrow(
      /must match its parent/,
    );
  });

  it('allows only a direct user to attach an unbound spawn to a mission', () => {
    const unboundWorker = context({ role: 'worker', missionId: undefined });
    const unboundUser = context({ role: 'user', missionId: undefined });

    expect(() => childMissionId(unboundWorker, 'mission-a')).toThrow(
      /only the user/,
    );
    expect(childMissionId(unboundUser, 'mission-a')).toBe('mission-a');
  });
});
