import { NEXUS_BRIDGE_HOST_KIND, type HostProfile } from '../transport/types'

/**
 * F-1037: "Tarefas" (GitHub/GitLab/Linear) e "Novo workspace" só funcionam num desktop
 * Orca. Com só hosts Nexus no catálogo os atalhos somem; num catálogo misto eles
 * miram apenas os hosts Orca conectados.
 */
export function selectHomeOrcaShortcuts(
  catalog: readonly { kind?: string }[],
  connectedHosts: readonly HostProfile[]
): { visible: boolean; connectedHosts: HostProfile[] } {
  return {
    visible: catalog.some((host) => host.kind !== NEXUS_BRIDGE_HOST_KIND),
    connectedHosts: connectedHosts.filter((host) => host.kind !== NEXUS_BRIDGE_HOST_KIND)
  }
}
