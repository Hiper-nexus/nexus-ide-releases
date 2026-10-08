// MOB-12 (F-1022): escopos por aparelho na Remote Bridge.
//
// Um ponto só decide se um pedido autenticado pode seguir: o tipo precisa
// estar nesta tabela (tipo desconhecido = recusa, fail closed) e o aparelho
// precisa ter o escopo que o tipo exige. A tabela é a lista de comandos do
// `handleAuthedMessage` (remote-bridge.ts); comando novo sem linha aqui é
// recusado e o teste de paridade (device-scopes.test.ts) fica vermelho.
import {
  REMOTE_DEVICE_SCOPES,
  type RemoteDeviceScope,
} from '../../shared/remote-types';

/**
 * Escopos de um grant salvo. Sem o campo (pareado antes do MOB-12) = todos os
 * escopos de hoje, para ninguém perder o acesso que já tinha. Campo presente
 * mas malformado = nenhum (fail closed); valores desconhecidos são ignorados.
 */
export function normalizeRemoteDeviceScopes(raw: unknown): RemoteDeviceScope[] {
  if (raw === undefined) return [...REMOTE_DEVICE_SCOPES];
  if (!Array.isArray(raw)) return [];
  return REMOTE_DEVICE_SCOPES.filter((scope) => raw.includes(scope));
}

// null = qualquer aparelho autenticado; o conteúdo é filtrado por escopo
// (status é a sonda de vida do app; snapshot e lista de panes saem vazios sem
// `read`, e os pedidos de aprovação aparecem com `read` ou `approve`).
const REQUIRED_SCOPE = new Map<string, RemoteDeviceScope | null>([
  ['status', null],
  ['ops.snapshot', null],
  ['panes.list', null],
  ['mission.list', 'read'],
  ['pane.read', 'read'],
  ['pane.stream.open', 'read'],
  ['pane.stream.close', 'read'],
  ['git.status', 'read'],
  ['git.diff', 'read'],
  ['files.list', 'read'],
  ['files.read', 'read'],
  ['pane.input', 'input'],
  ['pane.resize', 'input'],
  ['pane.stream.frame', 'input'],
  ['agentSession.respondToApproval', 'approve'],
  ['pane.close', 'close'],
]);

/** Tipos que o dispatch autenticado conhece (para o teste de paridade). */
export const REMOTE_DEVICE_REQUEST_TYPES: readonly string[] = [...REQUIRED_SCOPE.keys()];

/** Prefixo estável da recusa por escopo: o app traduz para pt-BR. */
export const REMOTE_SCOPE_MISSING_PREFIX = 'not authorized: scope-missing:';

export type RemoteDeviceRequestDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly error: string };

export function authorizeRemoteDeviceRequest(
  type: string,
  scopes: readonly RemoteDeviceScope[],
): RemoteDeviceRequestDecision {
  if (!REQUIRED_SCOPE.has(type)) {
    return { allowed: false, error: `unknown command: ${type}` };
  }
  const required = REQUIRED_SCOPE.get(type);
  if (required && !scopes.includes(required)) {
    return { allowed: false, error: `${REMOTE_SCOPE_MISSING_PREFIX}${required}` };
  }
  return { allowed: true };
}
