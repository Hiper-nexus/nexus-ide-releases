/**
 * Provider login surfaces that share a process-level credential (Claude CLI
 * rewrites the same keychain item). Concurrent missions each keep their own
 * Maestro; main only refuses a second orchestrator for the SAME mission until
 * that process proves physical exit. Renderer UX may still name the family.
 */
export function sharedAgentAuthFamily(
  adapterId: string | undefined,
): string | null {
  if (!adapterId) return null;
  const id = adapterId.toLowerCase();
  if (id.includes('claude')) return 'claude-shared-login';
  return null;
}
