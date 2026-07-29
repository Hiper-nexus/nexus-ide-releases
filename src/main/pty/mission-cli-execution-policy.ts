import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import type { SquadCliPolicy } from '../../shared/settings-types';

export interface MissionCliExecutionPolicyInput {
  readonly squadCliPolicy: SquadCliPolicy | string | undefined;
  readonly isMissionParticipant: boolean;
  readonly requestsNativeReadOnly: boolean;
  readonly requestsWorkspaceWriteSandbox: boolean;
  readonly requiresAdvisorySandbox: boolean;
  readonly isPetStudioWorkspaceWriter: boolean;
}

export interface MissionCliExecutionPolicy {
  /** Default vibe-coder mode: worktree + session bearer + Main-owned merge. */
  readonly isFrictionless: boolean;
  /** Provider/outer read-only confinement is hardened-mode-only. */
  readonly enforceNativeReadOnly: boolean;
  /** Provider/outer workspace confinement is hardened-mode-only. */
  readonly enforceWorkspaceWriteSandbox: boolean;
  /** Advisory Seatbelt is hardened-mode-only. */
  readonly applyAdvisorySandbox: boolean;
  /** Codex's private, offline profile is hardened-mode-only. */
  readonly preparePrivateCodexProfile: boolean;
  /** Add the provider's live web/search switch when it has one. */
  readonly enableLiveWeb: boolean;
}

/**
 * Compile the product mode once before provider-specific argv is assembled.
 *
 * Operator-choice is the default autopilot: the task runs in its dedicated
 * worktree with a per-session Nexus bearer and only Main can integrate it.
 * Provider and kernel sandboxes are deliberately reserved for the opt-in
 * governed mode because missing profiles, nested sandboxes and denied helper
 * subprocesses are availability failures rather than useful default safety.
 */
export function resolveMissionCliExecutionPolicy(
  input: MissionCliExecutionPolicyInput,
): MissionCliExecutionPolicy {
  const isOperatorChoice = isOperatorChoicePolicy(input.squadCliPolicy);
  const isFrictionless =
    isOperatorChoice &&
    input.isMissionParticipant &&
    !input.isPetStudioWorkspaceWriter;
  const isHardened = !isOperatorChoice || input.isPetStudioWorkspaceWriter;

  return Object.freeze({
    isFrictionless,
    enforceNativeReadOnly:
      isHardened && input.requestsNativeReadOnly,
    enforceWorkspaceWriteSandbox:
      isHardened && input.requestsWorkspaceWriteSandbox,
    applyAdvisorySandbox:
      isHardened && input.requiresAdvisorySandbox,
    preparePrivateCodexProfile:
      isHardened &&
      (input.isMissionParticipant || input.isPetStudioWorkspaceWriter),
    enableLiveWeb: isFrictionless,
  });
}
