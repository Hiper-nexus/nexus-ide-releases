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
  // OpenClaude is a separate binary (`~/.openclaude`). The substring
  // "claude" must not put it on the Anthropic keychain family.
  if (id === 'openclaude' || id.startsWith('openclaude-')) return null;
  if (id.includes('claude')) return 'claude-shared-login';
  return null;
}
