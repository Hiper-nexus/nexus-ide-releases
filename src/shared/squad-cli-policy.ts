/**
 * Dual-mode squad CLI policy.
 *
 * `operator-choice` (default): vibe-coder autopilot — any installed +
 * authenticated + handoff-capable CLI for Maestro/executor/reviewer. The
 * practical boundary is the task worktree, per-session Nexus authority and a
 * Main-owned validated merge. Provider auto-approve and network stay enabled.
 *
 * `governed`: release-qualified ladder — Codex for autonomous workspace write,
 * verified Maestro for coordination, advisory Seatbelt for everyone else on
 * read_only reviewer/scout lanes. Opt-in for operators who want the narrow gate.
 */

export const SQUAD_CLI_POLICY_MODES = ['governed', 'operator-choice'] as const;
export type SquadCliPolicyMode = (typeof SQUAD_CLI_POLICY_MODES)[number];

export function isOperatorChoicePolicy(
  mode: SquadCliPolicyMode | string | null | undefined,
): boolean {
  return mode === 'operator-choice';
}

export function squadCliPolicyLabel(mode: SquadCliPolicyMode): string {
  return mode === 'operator-choice'
    ? 'Autopiloto — qualquer CLI autenticada, com acesso de rede'
    : 'Hardened — sandbox e CLIs qualificadas';
}
