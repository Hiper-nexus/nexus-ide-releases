import { describe, expect, it } from 'vitest';
import { resolveMissionCliExecutionPolicy } from './mission-cli-execution-policy';

describe('resolveMissionCliExecutionPolicy', () => {
  it('keeps default mission participants online and free of process sandboxes', () => {
    expect(
      resolveMissionCliExecutionPolicy({
        squadCliPolicy: 'operator-choice',
        isMissionParticipant: true,
        requestsNativeReadOnly: true,
        requestsWorkspaceWriteSandbox: true,
        requiresAdvisorySandbox: true,
        isPetStudioWorkspaceWriter: false,
      }),
    ).toEqual({
      isFrictionless: true,
      enforceNativeReadOnly: false,
      enforceWorkspaceWriteSandbox: false,
      applyAdvisorySandbox: false,
      preparePrivateCodexProfile: false,
      enableLiveWeb: true,
    });
  });

  it('keeps every confinement boundary in opt-in governed mode', () => {
    expect(
      resolveMissionCliExecutionPolicy({
        squadCliPolicy: 'governed',
        isMissionParticipant: true,
        requestsNativeReadOnly: true,
        requestsWorkspaceWriteSandbox: true,
        requiresAdvisorySandbox: true,
        isPetStudioWorkspaceWriter: false,
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
});
