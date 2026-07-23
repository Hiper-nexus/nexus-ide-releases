/**
 * Provider login surfaces that cannot safely host two live orchestrators.
 * Renderer conflict UX is advisory; main uses the same exact family at the
 * physical process boundary.
 */
export function sharedAgentAuthFamily(
  adapterId: string | undefined,
): string | null {
  if (!adapterId) return null;
  const id = adapterId.toLowerCase();
  if (id.includes('claude')) return 'claude-shared-login';
  return null;
}
