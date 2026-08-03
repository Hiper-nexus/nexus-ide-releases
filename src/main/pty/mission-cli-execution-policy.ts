import {
  isGovernedPolicy,
  type SquadCliPolicyInput,
} from '../../shared/squad-cli-policy';

export interface MissionCliExecutionPolicyInput {
  readonly squadCliPolicy: SquadCliPolicyInput;
  readonly isMissionParticipant: boolean;
  readonly requestsNativeReadOnly: boolean;
  readonly requestsWorkspaceWriteSandbox: boolean;
  readonly requiresAdvisorySandbox: boolean;
  readonly isPetStudioWorkspaceWriter: boolean;
}

export interface MissionCliExecutionPolicy {
  /** Autopilot path: worktree + session bearer + Main-owned merge + YOLO. */
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
 * Default = Autopilot libre autopilot: dedicated worktree, per-session bearer,
 * Main-owned merge, provider YOLO/network on, **no** Seatbelt/bwrap/outer
 * Codex profile. Kernel sandboxes exist only when the operator explicitly
 * selected `governed` (or the special Pet Studio base-workspace writer).
 * Missing/unknown policy must never re-arm confinement — that was the path
 * that killed agy/kimi on /var/folders and gitdir denies.
 */
export function resolveMissionCliExecutionPolicy(
  input: MissionCliExecutionPolicyInput,
): MissionCliExecutionPolicy {
  // Single source of truth: Hardened is opt-in (or Pet Studio special case).
  const isHardened =
    isGovernedPolicy(input.squadCliPolicy) ||
    input.isPetStudioWorkspaceWriter;
  // Autopilot applies to every non-Hardened spawn — mission participant or
  // ad-hoc pane. Requiring isMissionParticipant here used to leave direct
  // terminals without YOLO/operatorChoiceParticipation while missions ran free.
  const isFrictionless = !isHardened;

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
