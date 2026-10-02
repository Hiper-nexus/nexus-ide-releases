/**
 * F-734: categoria saneada do StopFailure do Claude Code — o hook que a CLI
 * dispara NO LUGAR do Stop quando um erro de API encerrou o turno.
 *
 * Payload conferido no Claude Code 2.1.287 (schema e `executeStopFailureHooks`
 * no bundle do binário): campos comuns do hook + `hook_event_name:
 * "StopFailure"`, `error` (enum abaixo; sem erro tipado a CLI manda
 * "unknown"), `error_details?` e `last_assistant_message?`. Os dois últimos são
 * TEXTO DO PROVEDOR ("Please run /login · API Error: 401 … Your api key:
 * ****XXXX is invalid") e nunca são copiados, logados nem encaminhados: só a
 * categoria sai daqui.
 *
 * Enum `error` do 2.1.287: authentication_failed, oauth_org_not_allowed,
 * account_on_hold, verification_required, billing_error, rate_limit,
 * overloaded, invalid_request, model_not_found, server_error, unknown,
 * max_output_tokens, cloud_credential_error.
 *
 * Allowlist: só os valores que repetir não cura ganham categoria própria.
 * Limite de uso (rate_limit) é do failover de conta (F-249/F-718); erro
 * transitório (overloaded, server_error, cloud_credential_error, que a CLI
 * marca como transitório), corte de saída e valor desconhecido viram 'other'.
 */

export const AGENT_STOP_FAILURE_CATEGORIES = [
  'auth',
  'billing',
  'invalid_request',
  'other',
] as const;

export type AgentStopFailureCategory = (typeof AGENT_STOP_FAILURE_CATEGORIES)[number];

const CATEGORY_BY_PROVIDER_ERROR = new Map<string, AgentStopFailureCategory>([
  // Credencial recusada.
  ['authentication_failed', 'auth'],
  ['oauth_org_not_allowed', 'auth'],
  // Conta sem crédito, suspensa ou pendente de verificação.
  ['billing_error', 'billing'],
  ['account_on_hold', 'billing'],
  ['verification_required', 'billing'],
  // Pedido recusado: modelo que o endpoint não serve, parâmetro inválido.
  ['invalid_request', 'invalid_request'],
  ['model_not_found', 'invalid_request'],
]);

/** Valor do campo `error` do StopFailure → categoria. Nunca devolve o valor recebido. */
export function agentStopFailureCategory(error: unknown): AgentStopFailureCategory {
  if (typeof error !== 'string') return 'other';
  return CATEGORY_BY_PROVIDER_ERROR.get(error) ?? 'other';
}

export function isAgentStopFailureCategory(
  value: unknown,
): value is AgentStopFailureCategory {
  return (
    typeof value === 'string' &&
    (AGENT_STOP_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}
