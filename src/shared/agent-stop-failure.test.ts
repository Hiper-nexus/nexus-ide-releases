/**
 * F-734: o StopFailure do Claude Code só atravessa a normalização como
 * categoria de uma allowlist — nunca o texto do provedor.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_STOP_FAILURE_CATEGORIES,
  agentStopFailureCategory,
  isAgentStopFailureCategory,
} from './agent-stop-failure';

describe('agentStopFailureCategory (F-734)', () => {
  it('mapeia o enum `error` do Claude Code 2.1.287', () => {
    const expected: Record<string, string> = {
      authentication_failed: 'auth',
      oauth_org_not_allowed: 'auth',
      billing_error: 'billing',
      account_on_hold: 'billing',
      verification_required: 'billing',
      invalid_request: 'invalid_request',
      model_not_found: 'invalid_request',
      // F-1484: limite de uso é prova estruturada do provedor — categoria própria.
      rate_limit: 'rate_limit',
      // Transitórios ficam fora (F-718, retry da CLI).
      overloaded: 'other',
      server_error: 'other',
      max_output_tokens: 'other',
      cloud_credential_error: 'other',
      unknown: 'other',
    };
    for (const [error, category] of Object.entries(expected)) {
      expect(agentStopFailureCategory(error)).toBe(category);
    }
  });

  it('valor fora do enum nunca é copiado: vira other', () => {
    const leaked = 'API Error: 401 Authentication Fails, Your api key: ****ABCD is invalid';
    expect(agentStopFailureCategory(leaked)).toBe('other');
    expect(agentStopFailureCategory('AUTHENTICATION_FAILED')).toBe('other');
    expect(agentStopFailureCategory('__proto__')).toBe('other');
    expect(agentStopFailureCategory('constructor')).toBe('other');
    expect(agentStopFailureCategory(undefined)).toBe('other');
    expect(agentStopFailureCategory(401)).toBe('other');
    expect(agentStopFailureCategory({ error: 'authentication_failed' })).toBe('other');
  });

  it('a guarda aceita só as categorias da allowlist', () => {
    for (const category of AGENT_STOP_FAILURE_CATEGORIES) {
      expect(isAgentStopFailureCategory(category)).toBe(true);
    }
    expect(isAgentStopFailureCategory('authentication_failed')).toBe(false);
    expect(isAgentStopFailureCategory('rate-limit')).toBe(false);
    expect(isAgentStopFailureCategory('overloaded')).toBe(false);
    expect(isAgentStopFailureCategory(undefined)).toBe(false);
  });

  it('F-1484: rate_limit atravessa a normalização como categoria própria', () => {
    expect(agentStopFailureCategory('rate_limit')).toBe('rate_limit');
    expect(isAgentStopFailureCategory('rate_limit')).toBe(true);
    // Só o valor exato do enum: prosa de limite nunca vira a categoria.
    expect(agentStopFailureCategory('Rate limit reached')).toBe('other');
    expect(agentStopFailureCategory('rate_limit_exceeded')).toBe('other');
    expect(agentStopFailureCategory('RATE_LIMIT')).toBe('other');
  });
});
