import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGatewayBaseUrls,
  applyGatewayCredential,
  GATEWAY_API_KEY_ENV,
  GATEWAY_BASE_URL_ENV,
  GATEWAY_OUT_OF_REACH_VARS,
  gatewayForwardsProviderCredential,
  gatewayRoutedVars,
  normalizeGatewayBaseUrl,
  resolveGatewayApiKey,
  resolveGatewayBaseUrl,
} from './gateway-env';

const GATEWAY = 'http://127.0.0.1:20128/v1';

const claudeLike = {
  id: 'claude',
  env: { passthrough: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveGatewayBaseUrl', () => {
  it('reads the gateway URL and strips the trailing slash', () => {
    expect(
      resolveGatewayBaseUrl({ [GATEWAY_BASE_URL_ENV]: `${GATEWAY}/` }),
    ).toBe(GATEWAY);
  });

  it('stays off when the variable is absent', () => {
    expect(resolveGatewayBaseUrl({})).toBeNull();
  });

  it('refuses a non-http scheme instead of feeding it to every CLI', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveGatewayBaseUrl({ [GATEWAY_BASE_URL_ENV]: 'file:///etc/passwd' }),
    ).toBeNull();
    expect(
      resolveGatewayBaseUrl({ [GATEWAY_BASE_URL_ENV]: 'não é url' }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('applyGatewayBaseUrls', () => {
  it('points only the base-URL vars the adapter itself declared', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'k' };
    applyGatewayBaseUrls(env, claudeLike, GATEWAY);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
    // Nunca inventa uma var que a CLI não conhece.
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    // Nunca toca em credencial.
    expect(env.ANTHROPIC_API_KEY).toBe('k');
  });

  it('leaves everything untouched when no gateway is configured', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://original' };
    applyGatewayBaseUrls(env, claudeLike, null);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://original');
  });

  it('routes the OpenAI surface for adapters that declare it', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGatewayBaseUrls(
      env,
      { id: 'codex', env: { passthrough: ['OPENAI_BASE_URL'] } },
      GATEWAY,
    );
    expect(env.OPENAI_BASE_URL).toBe(GATEWAY);
  });
});

describe('normalizeGatewayBaseUrl', () => {
  it('names the origin in the warning so o operador sabe onde corrigir', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeGatewayBaseUrl('nada', 'configurações')).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('configurações');
  });

  it('accepts empty/undefined as "gateway desligado"', () => {
    expect(normalizeGatewayBaseUrl('')).toBeNull();
    expect(normalizeGatewayBaseUrl(undefined)).toBeNull();
    expect(normalizeGatewayBaseUrl('  ')).toBeNull();
  });
});

describe('gatewayRoutedVars', () => {
  it('lists only the routable vars the adapter declared', () => {
    expect(gatewayRoutedVars(claudeLike)).toEqual(['ANTHROPIC_BASE_URL']);
    expect(
      gatewayRoutedVars({ env: { passthrough: ['KIMI_MODEL_BASE_URL'] } }),
    ).toEqual([]);
  });

  it('documents why a declared base URL stays out of reach', () => {
    // Kimi fica de fora de propósito: a base URL dele é de MODELO, amarrada ao
    // provider-type e à key no mesmo trio. O registro existe para o log dizer
    // isso ao operador em vez de silenciar.
    expect(GATEWAY_OUT_OF_REACH_VARS.get('KIMI_MODEL_BASE_URL')).toContain(
      'modelo',
    );
  });
});

describe('gateway credential', () => {
  it('reads the gateway key from the environment', () => {
    expect(resolveGatewayApiKey({ [GATEWAY_API_KEY_ENV]: ' k ' })).toBe('k');
    expect(resolveGatewayApiKey({})).toBeNull();
  });

  it('injects the key only into declared credential vars', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGatewayCredential(env, claudeLike, GATEWAY, 'gw');
    expect(env.ANTHROPIC_API_KEY).toBe('gw');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('never invents a credential var the CLI does not declare', () => {
    const env: NodeJS.ProcessEnv = {};
    // Declara a base URL mas NÃO a key: nada é inventado.
    applyGatewayCredential(
      env,
      { id: 'x', env: { passthrough: ['ANTHROPIC_BASE_URL'] } },
      GATEWAY,
      'gw',
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('stays inert when the gateway is off or has no key', () => {
    const off: NodeJS.ProcessEnv = {};
    applyGatewayCredential(off, claudeLike, null, 'gw');
    expect(off.ANTHROPIC_API_KEY).toBeUndefined();
    const noKey: NodeJS.ProcessEnv = {};
    applyGatewayCredential(noKey, claudeLike, GATEWAY, null);
    expect(noKey.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('flags that the provider credential travels when no gateway key is set', () => {
    expect(gatewayForwardsProviderCredential(claudeLike, GATEWAY, null)).toBe(
      true,
    );
    expect(gatewayForwardsProviderCredential(claudeLike, GATEWAY, 'gw')).toBe(
      false,
    );
    // Adapter que o gateway nem alcança não encaminha nada.
    expect(
      gatewayForwardsProviderCredential(
        { env: { passthrough: ['KIMI_MODEL_BASE_URL'] } },
        GATEWAY,
        null,
      ),
    ).toBe(false);
  });
});
