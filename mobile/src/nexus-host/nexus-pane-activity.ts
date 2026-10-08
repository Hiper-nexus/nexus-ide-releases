// MOB-05 (F-1021): atividade de cada pane do desktop Nexus no app — trabalhando,
// esperando você, terminou/parado, encerrado. O estado vem do desktop (push
// `pane.activity` + `pane.activity.list` ao conectar); o app só guarda o último
// por pane e diz qual mudança foi uma transição de verdade (para notificar).
import { useEffect, useRef, useState } from 'react'
import type {
  NexusHostApi,
  NexusPaneActivity,
  NexusPaneActivityState
} from '../transport/nexus-bridge-rpc-adapter'
import type { ConnectionState } from '../transport/types'

export type NexusPaneActivityView = {
  readonly activity: NexusPaneActivityState
  readonly at: number
  /** A atividade anterior que ESTE app viu (null = primeira leitura). */
  readonly previous: NexusPaneActivityState | null
}

export type NexusPaneActivityTransition = {
  readonly paneId: string
  readonly from: NexusPaneActivityState | null
  readonly to: NexusPaneActivityState
  readonly at: number
}

export type NexusPaneActivityTone = 'working' | 'waiting' | 'done' | 'off'

export type NexusPaneActivityMap = ReadonlyMap<string, NexusPaneActivityView>

/**
 * Aplica uma leitura do desktop. `push`: o desktop disse que mudou agora (sempre
 * transição). `list`: releitura ao conectar — só é transição se o app já
 * conhecia outro estado para o pane (mudou enquanto estava desconectado).
 */
export function applyNexusPaneActivity(
  map: NexusPaneActivityMap,
  entry: NexusPaneActivity,
  origin: 'push' | 'list'
): { next: NexusPaneActivityMap; transition: NexusPaneActivityTransition | null } {
  const current = map.get(entry.paneId)
  if (current && current.activity === entry.activity && current.at === entry.at) {
    return { next: map, transition: null }
  }
  if (current && entry.at > 0 && entry.at < current.at) {
    // Leitura mais velha que o que o app já tem (lista atrasada atrás de um push).
    return { next: map, transition: null }
  }
  const changed = current?.activity !== entry.activity
  const next = new Map(map)
  next.set(entry.paneId, {
    activity: entry.activity,
    at: entry.at,
    previous: changed ? (current?.activity ?? null) : (current?.previous ?? null)
  })
  const isTransition = changed && (origin === 'push' || current !== undefined)
  return {
    next,
    transition: isTransition
      ? { paneId: entry.paneId, from: current?.activity ?? null, to: entry.activity, at: entry.at }
      : null
  }
}

/** Sem leitura de atividade, o estado do snapshot ainda diz algo. */
export function nexusActivityFromPaneState(state: string): NexusPaneActivityView | null {
  const activity: NexusPaneActivityState | null =
    state === 'busy' || state === 'spawning'
      ? 'working'
      : state === 'idle' || state === 'parked' || state === 'hibernated'
        ? 'idle'
        : state === 'exited'
          ? 'exited'
          : null
  return activity ? { activity, at: 0, previous: null } : null
}

export function nexusPaneActivityLabel(view: NexusPaneActivityView): {
  readonly label: string
  readonly detail: string
  readonly tone: NexusPaneActivityTone
} {
  switch (view.activity) {
    case 'working':
      return { label: 'Trabalhando', detail: 'O agente está executando no desktop.', tone: 'working' }
    case 'waiting':
      return {
        label: 'Esperando você',
        detail: 'O agente parou numa pergunta ou permissão. Responda pelo comando ou pela aprovação.',
        tone: 'waiting'
      }
    case 'idle':
      return view.previous === 'working' || view.previous === 'waiting'
        ? { label: 'Terminou', detail: 'O turno acabou e o pane está livre.', tone: 'done' }
        : { label: 'Parado', detail: 'Nada rodando neste pane agora.', tone: 'off' }
    case 'exited':
      return { label: 'Encerrado', detail: 'A sessão deste pane terminou no desktop.', tone: 'off' }
  }
}

/** "agora", "há 3 min", "há 2 h" — relógio do desktop contra o do celular. */
export function nexusActivitySince(at: number, now: number): string {
  if (at <= 0) {
    return ''
  }
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) {
    return 'agora'
  }
  return minutes < 60 ? `há ${minutes} min` : `há ${Math.floor(minutes / 60)} h`
}

/**
 * Mantém a atividade por pane enquanto o host está conectado: relê a lista a
 * cada conexão (também depois de reconectar) e aplica cada push.
 */
export function useNexusPaneActivity(args: {
  nexus: NexusHostApi | null
  state: ConnectionState
  onTransition?: (transition: NexusPaneActivityTransition) => void
}): NexusPaneActivityMap {
  const { nexus, state } = args
  const [map, setMap] = useState<NexusPaneActivityMap>(() => new Map())
  const mapRef = useRef(map)
  const onTransitionRef = useRef(args.onTransition)
  onTransitionRef.current = args.onTransition

  useEffect(() => {
    if (!nexus || state !== 'connected') {
      return
    }
    let cancelled = false
    const apply = (entry: NexusPaneActivity, origin: 'push' | 'list') => {
      const result = applyNexusPaneActivity(mapRef.current, entry, origin)
      if (result.next === mapRef.current) {
        return
      }
      mapRef.current = result.next
      setMap(result.next)
      if (result.transition) {
        onTransitionRef.current?.(result.transition)
      }
    }
    const unsubscribe = nexus.onPaneActivity((entry) => apply(entry, 'push'))
    nexus.paneActivity().then(
      (entries) => {
        if (!cancelled) {
          for (const entry of entries) {
            apply(entry, 'list')
          }
        }
      },
      () => undefined // desktop antigo sem pane.activity.list: só os pushes valem
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [nexus, state])

  return map
}
