/**
 * Dual-mode squad CLI policy (Overclock-order product floor).
 *
 * `operator-choice` (default / missing / unknown): vibe-coder autopilot —
 * any installed + authenticated + handoff-capable CLI. Boundary = task
 * worktree + per-session Nexus bearer + Main-owned merge. Provider
 * auto-approve and network stay on. No OS Seatbelt/bwrap on panes.
 *
 * `governed` (explicit opt-in only): release-qualified ladder — Codex writers,
 * verified Maestro, advisory Seatbelt on read_only lanes. Never the silent
 * fallback when settings or call sites omit the policy.
 */

export const SQUAD_CLI_POLICY_MODES = ['governed', 'operator-choice'] as const;
export type SquadCliPolicyMode = (typeof SQUAD_CLI_POLICY_MODES)[number];

export type SquadCliPolicyInput =
  | SquadCliPolicyMode
  | string
  | null
  | undefined;

/** Canonical form for comparisons; empty/unknown → empty string. */
export function normalizeSquadCliPolicyInput(
  mode: SquadCliPolicyInput,
): string {
  if (mode == null) return '';
  return String(mode).trim().toLowerCase();
}

/**
 * True only when the operator explicitly chose Hardened.
 * Accepts case/whitespace variants (`Governed`, ` governed `) so opt-in is
 * not lost to sloppy call sites; everything else is Autopilot.
 */
export function isGovernedPolicy(mode: SquadCliPolicyInput): boolean {
  return normalizeSquadCliPolicyInput(mode) === 'governed';
}

/**
 * Autopilot is the product default. Anything that is not the explicit
 * `governed` opt-in (including undefined/null/typos) stays vibe-coder so a
 * missing policy never re-introduces kernel sandbox or CLI ladder gates.
 *
 * Note: this is **not** `mode === 'operator-choice'`. It means
 * "not Hardened" — the runtime Autopilot path.
 */
export function isOperatorChoicePolicy(mode: SquadCliPolicyInput): boolean {
  return !isGovernedPolicy(mode);
}

export function squadCliPolicyLabel(mode: SquadCliPolicyMode): string {
  return mode === 'operator-choice'
    ? 'Autopiloto — qualquer CLI autenticada, com acesso de rede'
    : 'Hardened — sandbox e CLIs qualificadas (opt-in)';
}
