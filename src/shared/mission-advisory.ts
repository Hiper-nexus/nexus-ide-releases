/**
 * Advisory participation lane (multi-CLI squad coverage): CLIs without an
 * enforceable native read/write confinement of their own. They join read_only
 * reviewer/scout tasks confined by the Nexus kernel sandbox, with physical
 * PTY/MCP/handoff receipts — the evidence records the tier as
 * advisory-unconfined, never as mechanically confined.
 *
 * claude is advisory for the plan/dispatch eligibility checks, but it IS
 * natively confined (governed read-only argv), so it only participates when
 * the mission orchestrator is not Claude (reserveClaude).
 */
/**
 * Advisory participation is DERIVED, never enumerated.
 *
 * The confinement that makes an advisor safe belongs to Nexus (the kernel
 * sandbox in advisory-process-sandbox), not to the provider — so there is
 * nothing to audit per CLI, and keeping a hand-written allowlist would only
 * lock out every CLI the operator adds later. A newly installed provider is
 * advisory the moment its adapter exists: no code change, no release.
 *
 * A CLI is advisory when it does NOT already confine itself. codex and grok
 * carry their own verified read-only profile and use it; everyone else borrows
 * the Nexus boundary. The remaining requirements — a live adapter route, a
 * per-session private HOME, a real binary — are checked where the adapter is
 * actually known (squad-runtime-policy, advisory-process-sandbox), and each of
 * them fails closed.
 */
export function supportsAdvisoryParticipationCli(adapterId: string): boolean {
  const id = adapterId.trim();
  if (!id) return false;
  return !supportsMechanicallyReadOnlyCli(id);
}

/**
 * Advisory CLIs without any enforceable native read-only confinement. These
 * run with the Nexus MCP read-only authority as the only boundary and must
 * never be pushed through the governed native argv path.
 */
export function isAdvisoryUnconfinedCli(adapterId: string): boolean {
  return (
    adapterId !== 'claude' && supportsAdvisoryParticipationCli(adapterId)
  );
}

/**
 * CLIs whose read_only lane is enforced by a mechanism outside the prompt.
 * codex: governed argv profile. grok: kernel Seatbelt `--sandbox read-only`.
 */
const MECHANICALLY_READ_ONLY_CLIS = new Set(['codex', 'grok']);

export function supportsMechanicallyReadOnlyCli(adapterId: string): boolean {
  return MECHANICALLY_READ_ONLY_CLIS.has(adapterId);
}

/**
 * Every CLI that can hold a read_only lane in a mission, by either boundary:
 * a mechanical confinement (codex/grok) or the Nexus MCP read-only authority
 * (the advisory tier). Squad readiness uses this to admit reviewer/scout
 * participants that never need autonomous workspace write — the authority
 * demanded of executors. It is NOT a write grant and never covers executors.
 */
export function supportsReadOnlyParticipationCli(adapterId: string): boolean {
  return (
    supportsMechanicallyReadOnlyCli(adapterId) ||
    supportsAdvisoryParticipationCli(adapterId)
  );
}
