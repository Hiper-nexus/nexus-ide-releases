import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({}))

import {
  applyNexusPaneActivity,
  nexusActivityFromPaneState,
  nexusActivitySince,
  nexusPaneActivityLabel,
  type NexusPaneActivityMap
} from './nexus-pane-activity'

const EMPTY: NexusPaneActivityMap = new Map()

describe('atividade dos panes no host Nexus (MOB-05)', () => {
  it('a primeira leitura da lista não é transição; o push é', () => {
    const seeded = applyNexusPaneActivity(EMPTY, { paneId: 'p1', activity: 'working', at: 10 }, 'list')
    expect(seeded.transition).toBeNull()
    expect(seeded.next.get('p1')).toEqual({ activity: 'working', at: 10, previous: null })

    const pushed = applyNexusPaneActivity(seeded.next, { paneId: 'p1', activity: 'waiting', at: 20 }, 'push')
    expect(pushed.transition).toEqual({ paneId: 'p1', from: 'working', to: 'waiting', at: 20 })
    expect(pushed.next.get('p1')).toEqual({ activity: 'waiting', at: 20, previous: 'working' })

    // Push de pane que o app ainda não conhecia também é transição (de "nada").
    const fresh = applyNexusPaneActivity(EMPTY, { paneId: 'p2', activity: 'waiting', at: 5 }, 'push')
    expect(fresh.transition).toEqual({ paneId: 'p2', from: null, to: 'waiting', at: 5 })
  })

  it('a releitura depois de reconectar só vira transição se o estado mudou', () => {
    const known = applyNexusPaneActivity(EMPTY, { paneId: 'p1', activity: 'working', at: 10 }, 'push').next
    const same = applyNexusPaneActivity(known, { paneId: 'p1', activity: 'working', at: 10 }, 'list')
    expect(same.transition).toBeNull()
    expect(same.next).toBe(known)
    const changed = applyNexusPaneActivity(known, { paneId: 'p1', activity: 'idle', at: 30 }, 'list')
    expect(changed.transition).toEqual({ paneId: 'p1', from: 'working', to: 'idle', at: 30 })
    // Lista atrasada (mais velha que o push já aplicado) não volta o estado.
    const stale = applyNexusPaneActivity(changed.next, { paneId: 'p1', activity: 'working', at: 10 }, 'list')
    expect(stale.next).toBe(changed.next)
    expect(stale.transition).toBeNull()
  })

  it('rótulos: terminou só depois de trabalhar; parado sem histórico', () => {
    expect(nexusPaneActivityLabel({ activity: 'waiting', at: 1, previous: 'working' })).toMatchObject({
      label: 'Esperando você',
      tone: 'waiting'
    })
    expect(nexusPaneActivityLabel({ activity: 'idle', at: 1, previous: 'working' }).label).toBe('Terminou')
    expect(nexusPaneActivityLabel({ activity: 'idle', at: 1, previous: null }).label).toBe('Parado')
    expect(nexusPaneActivityLabel({ activity: 'working', at: 1, previous: null }).label).toBe('Trabalhando')
    expect(nexusPaneActivityLabel({ activity: 'exited', at: 1, previous: 'idle' }).label).toBe('Encerrado')
  })

  it('sem leitura de atividade, usa o estado do snapshot', () => {
    expect(nexusActivityFromPaneState('busy')?.activity).toBe('working')
    expect(nexusActivityFromPaneState('spawning')?.activity).toBe('working')
    expect(nexusActivityFromPaneState('idle')?.activity).toBe('idle')
    expect(nexusActivityFromPaneState('exited')?.activity).toBe('exited')
    expect(nexusActivityFromPaneState('unknown')).toBeNull()
  })

  it('tempo desde a transição', () => {
    expect(nexusActivitySince(0, 1_000)).toBe('')
    expect(nexusActivitySince(1_000, 30_000)).toBe('agora')
    expect(nexusActivitySince(1_000, 1_000 + 3 * 60_000)).toBe('há 3 min')
    expect(nexusActivitySince(1_000, 1_000 + 125 * 60_000)).toBe('há 2 h')
    // Relógio do celular atrás do desktop: nunca "há -1 min".
    expect(nexusActivitySince(10_000, 1_000)).toBe('agora')
  })
})
