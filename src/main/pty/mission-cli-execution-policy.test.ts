import { describe, expect, it } from 'vitest';
import { resolveMissionCliExecutionPolicy } from './mission-cli-execution-policy';

const vibeRequests = {
  isMissionParticipant: true,
  requestsNativeReadOnly: true,
  requestsWorkspaceWriteSandbox: true,
  requiresAdvisorySandbox: true,
  isPetStudioWorkspaceWriter: false,
} as const;

const noSandbox = {
  isFrictionless: true,
  enforceNativeReadOnly: false,
  enforceWorkspaceWriteSandbox: false,
  applyAdvisorySandbox: false,
  preparePrivateCodexProfile: false,
  enableLiveWeb: true,
} as const;

describe('resolveMissionCliExecutionPolicy', () => {
  it('keeps Autopilot free of process sandboxes for mission participants', () => {
    expect(
      resolveMissionCliExecutionPolicy({
        squadCliPolicy: 'operator-choice',
        ...vibeRequests,
      }),
    ).toEqual(noSandbox);
  });

  it('keeps Autopilot free of process sandboxes for ad-hoc (non-mission) panes', () => {
    expect(
      resolveMissionCliExecutionPolicy({
        squadCliPolicy: 'operator-choice',
        ...vibeRequests,
        isMissionParticipant: false,
      }),
    ).toEqual(noSandbox);
  });

  it('never re-arms kernel sandboxes when policy is missing or unknown', () => {
    for (const squadCliPolicy of [
      undefined,
      null,
      '',
      'yolo',
      'autopilot',
      'hardended',
    ] as const) {
      const policy = resolveMissionCliExecutionPolicy({
        squadCliPolicy,
        ...vibeRequests,
      });
      expect(policy).toEqual(noSandbox);
    }
  });

  it('recognizes case/whitespace variants of governed as Hardened opt-in', () => {
    for (const squadCliPolicy of ['governed', 'Governed', ' GOVERNED '] as const) {
      expect(
        resolveMissionCliExecutionPolicy({
          squadCliPolicy,
          ...vibeRequests,
        }),
      ).toEqual({
        isFrictionless: false,
        enforceNativeReadOnly: true,
        enforceWorkspaceWriteSandbox: true,
        applyAdvisorySandbox: true,
        preparePrivateCodexProfile: true,
        enableLiveWeb: false,
      });
    }
  });

  it('keeps every confinement boundary in opt-in governed mode', () => {
    expect(
      resolveMissionCliExecutionPolicy({
        squadCliPolicy: 'governed',
        ...vibeRequests,
      }),
    ).toEqual({
      isFrictionless: false,
      enforceNativeReadOnly: true,
      enforceWorkspaceWriteSandbox: true,
      applyAdvisorySandbox: true,
      preparePrivateCodexProfile: true,
      enableLiveWeb: false,
    });
  });

  it('preserves the special base-workspace Pet boundary in either mode', () => {
    const policy = resolveMissionCliExecutionPolicy({
      squadCliPolicy: 'operator-choice',
      isMissionParticipant: true,
      requestsNativeReadOnly: false,
      requestsWorkspaceWriteSandbox: true,
      requiresAdvisorySandbox: false,
      isPetStudioWorkspaceWriter: true,
    });

    expect(policy.isFrictionless).toBe(false);
    expect(policy.enforceWorkspaceWriteSandbox).toBe(true);
    expect(policy.preparePrivateCodexProfile).toBe(true);
    expect(policy.enableLiveWeb).toBe(false);
  });

  it('does not prepare private Codex profile for Hardened non-participants', () => {
    const policy = resolveMissionCliExecutionPolicy({
      squadCliPolicy: 'governed',
      ...vibeRequests,
      isMissionParticipant: false,
    });
    expect(policy.preparePrivateCodexProfile).toBe(false);
    expect(policy.applyAdvisorySandbox).toBe(true);
    expect(policy.isFrictionless).toBe(false);
  });
});
