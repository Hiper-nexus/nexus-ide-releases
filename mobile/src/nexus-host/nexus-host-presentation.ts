// F-1037: rótulos pt-BR do host Nexus. O desktop manda estados crus em inglês
// (missão `running`, pane `busy`…); a tela mostra a palavra em português e deixa
// passar, como veio, qualquer valor que ainda não tenha tradução.
import type { ConnectionState } from '../transport/types'

const MISSION_STATUS_LABEL: Readonly<Record<string, string>> = {
  running: 'em andamento',
  done: 'concluída',
  blocked: 'bloqueada',
  failed: 'falhou',
  pending: 'pendente'
}

const PANE_STATE_LABEL: Readonly<Record<string, string>> = {
  busy: 'ocupado',
  idle: 'ocioso',
  spawning: 'iniciando',
  exited: 'encerrado',
  parked: 'estacionado'
}

function ownLabel(table: Readonly<Record<string, string>>, value: string): string {
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : value
}

export function nexusMissionStatusLabel(status: string): string {
  return ownLabel(MISSION_STATUS_LABEL, status)
}

export function nexusPaneStateLabel(state: string): string {
  return ownLabel(PANE_STATE_LABEL, state)
}

/** Linha de estado do card do host Nexus na Início (o caminho real é o Tailscale Serve). */
export const NEXUS_HOST_CARD_STATUS: Readonly<Record<ConnectionState, string>> = {
  connecting: 'Conectando…',
  handshaking: 'Autenticando…',
  connected: 'Conectado · Desktop Nexus',
  disconnected: 'Desconectado',
  reconnecting: 'Reconectando…',
  'auth-failed': 'Sessão encerrada: pareie de novo'
}

/**
 * F-1037: o que fica abaixo do cabeçalho. Com a credencial revogada (`auth-failed`)
 * nada do que veio do desktop continua na tela: só o "Parear de novo" e, se havia um
 * pane aberto, as abas Alterações/Arquivos desabilitadas.
 */
export type NexusHostBody = 'revoked' | 'revoked-pane' | 'workspace' | 'pane' | 'list'

export function nexusHostBody(
  state: ConnectionState,
  paneOpen: boolean,
  workspaceOpen: boolean
): NexusHostBody {
  if (state === 'auth-failed') {
    return paneOpen ? 'revoked-pane' : 'revoked'
  }
  if (paneOpen) {
    return workspaceOpen ? 'workspace' : 'pane'
  }
  return 'list'
}
