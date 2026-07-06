/**
 * Canais + tipos do auto-update. Dependency-free (sem zod/node) para o preload
 * sandboxed e o main importarem igual — mesmo contrato dos VOICE_CHANNELS.
 */

export const UPDATE_CHANNELS = {
  /** invoke: renderer → main. Snapshot do estado atual do updater. */
  getState: 'update:getState',
  /** invoke: renderer → main. Checa agora se há versão nova (gh/feed). */
  check: 'update:check',
  /** invoke: renderer → main. Baixa + prepara a atualização (Squirrel). */
  install: 'update:install',
  /** invoke: renderer → main. Update pronto → reinicia aplicando. */
  restart: 'update:restart',
  /** event: main → renderer. Estado do updater mudou. */
  state: 'update:state',
} as const;

export type UpdatePhase =
  /** Sem fonte de update disponível (sem feed e sem gh) — instalação manual. */
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'uptodate'
  /** Há versão nova conhecida; aguardando o usuário mandar baixar. */
  | 'available'
  | 'downloading'
  /** Baixada + validada pelo Squirrel — falta só reiniciar. */
  | 'ready'
  | 'error';

export interface UpdateAvailableInfo {
  version: string;
  tag: string;
  publishedAt?: string;
  /** Primeiras linhas das notas do release (para o modal). */
  notes?: string;
}

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  /** De onde os updates vêm: feed Squirrel direto, gh CLI, ou nada. */
  source: 'feed' | 'gh' | 'none';
  available?: UpdateAvailableInfo;
  error?: string;
  /** Epoch ms da última checagem concluída (uptodate/available). */
  checkedAt?: number;
  /** false em dev (não empacotado): checa, mas não instala. */
  canInstall: boolean;
}
