import { useEffect, useState } from 'react'
import { loadHostCatalog } from '../transport/host-store'
import { NEXUS_BRIDGE_HOST_KIND } from '../transport/types'

/**
 * F-1037: o onboarding fala do desktop em jogo. Com `hostId` (logo após parear) vale
 * o tipo desse host; sem ele (vindo da Início), só conta como Nexus quando todos os
 * hosts salvos são Nexus. Enquanto o catálogo carrega, devolve false.
 */
export function useOnboardingNexusHost(hostId: string | undefined): boolean {
  const [nexus, setNexus] = useState(false)
  useEffect(() => {
    let cancelled = false
    void loadHostCatalog()
      .then((catalog) => {
        const kinds = hostId
          ? catalog.filter((entry) => entry.id === hostId).map((entry) => entry.kind)
          : catalog.map((entry) => entry.kind)
        return kinds.length > 0 && kinds.every((kind) => kind === NEXUS_BRIDGE_HOST_KIND)
      })
      .catch(() => false)
      .then((value) => {
        if (!cancelled) {
          setNexus(value)
        }
      })
    return () => {
      cancelled = true
    }
  }, [hostId])
  return nexus
}
