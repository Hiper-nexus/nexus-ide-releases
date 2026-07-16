/**
 * Renderer-local signal that integration credentials changed (token saved,
 * key updated). Surfaces that let stale issue/PR lists refetch without a
 * workspace switch. Kept as a plain window event so unrelated components
 * (MissionRail, IntegrationsPanel) stay decoupled from each other.
 */
export const INTEGRATIONS_CHANGED_EVENT = 'nexus:integrations-changed';

export function emitIntegrationsChanged(): void {
  window.dispatchEvent(new Event(INTEGRATIONS_CHANGED_EVENT));
}
