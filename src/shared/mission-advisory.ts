/**
 * Advisory participation lane (multi-CLI squad coverage): CLIs with a real
 * Nexus MCP injection path but NO enforceable native read/write confinement.
 * They may join read_only reviewer/scout tasks with MCP read-only authority
 * and physical PTY/MCP/handoff receipts — the evidence records the tier as
 * advisory-unconfined, never as mechanically confined.
 *
 * Membership notes:
 * - claude is listed for the plan/dispatch eligibility checks, but it IS
 *   natively confined (governed read-only argv) and only participates when
 *   the mission orchestrator is not Claude (reserveClaude);
 * - codex/grok are NOT advisory: they have mechanically confined read_only
 *   lanes (see MECHANICALLY_READ_ONLY_CLIS below);
 * - aider has no Nexus MCP path and can never be advisory.
 */
const ADVISORY_PARTICIPATION_CLIS = new Set([
  'claude',
  'kimi',
  'agy',
  'opencode',
  'omp',
]);

export function supportsAdvisoryParticipationCli(adapterId: string): boolean {
  return ADVISORY_PARTICIPATION_CLIS.has(adapterId);
}

/**
 * Advisory CLIs without any enforceable native read-only confinement. These
 * run with the Nexus MCP read-only authority as the only boundary and must
 * never be pushed through the governed native argv path.
 */
export function isAdvisoryUnconfinedCli(adapterId: string): boolean {
  return adapterId !== 'claude' && ADVISORY_PARTICIPATION_CLIS.has(adapterId);
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
