/**
 * Origem da rota de um pane aberto por agente do operador (A, 25/09) — o que
 * o recibo, o chip do cabeçalho e o toast dizem quando o Jev não respondeu.
 * Vive em shared porque Main produz e renderer exibe.
 */
export type JevUnavailableReason =
  | 'disabled'
  | 'no-key'
  | 'invalid-answer'
  | 'timeout'
  | 'rate-limited'
  | 'client-error'
  | 'server-error'
  | 'network'
  | 'malformed'
  | 'aborted';

export type SpawnRouteSource = 'jev' | 'mixed' | 'heuristic';

export interface SpawnRouteInfo {
  readonly source: SpawnRouteSource;
  readonly jevUnavailable?: JevUnavailableReason;
}

export const JEV_UNAVAILABLE_LABEL: Readonly<Record<JevUnavailableReason, string>> = {
  disabled: 'desligado nas Configurações',
  'no-key': 'sem chave',
  'invalid-answer': 'resposta inválida',
  timeout: 'tempo esgotado',
  'rate-limited': 'limite de uso',
  'client-error': 'requisição recusada',
  'server-error': 'serviço fora',
  network: 'sem rede',
  malformed: 'resposta malformada',
  aborted: 'cancelado',
};

export function isJevUnavailableReason(value: unknown): value is JevUnavailableReason {
  return typeof value === 'string' && Object.hasOwn(JEV_UNAVAILABLE_LABEL, value);
}
