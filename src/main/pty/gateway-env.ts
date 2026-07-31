/**
 * Gateway de IA local (ex.: OmniRoute) na frente das CLIs.
 *
 * Um provider que morre (401, cota) derruba o worker mesmo com o reroute — o
 * gateway resolve a camada de baixo: as CLIs falam com um endpoint local que
 * troca de provider por conta própria, e o Nexus nem vê a falha. A integração
 * é deliberadamente pela superfície que as CLIs JÁ suportam: as variáveis
 * `*_BASE_URL` compatíveis com os protocolos Anthropic/OpenAI.
 *
 * Regras de segurança do desenho:
 * - Só entram vars que o adapter DECLAROU no próprio passthrough — o gateway
 *   nunca inventa uma variável que a CLI não conhece.
 * - `static` do adapter vence o gateway (aplicado depois no agentEnv): glm e
 *   longcat pinam `ANTHROPIC_BASE_URL` no endpoint do próprio plano — apontar
 *   isso para um gateway quebraria a identidade do provider.
 * - URL inválida é ignorada com aviso; nunca derruba o spawn.
 */

export const GATEWAY_BASE_URL_ENV = 'NEXUS_AI_GATEWAY_BASE_URL';

/** Superfícies de protocolo que um gateway OmniRoute-like expõe. */
const GATEWAY_ROUTABLE_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
]);

export function resolveGatewayBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[GATEWAY_BASE_URL_ENV]?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(
        `[gateway] ${GATEWAY_BASE_URL_ENV} ignorada: protocolo ` +
          `${parsed.protocol} não é http(s)`,
      );
      return null;
    }
    return raw.replace(/\/+$/, '');
  } catch {
    console.warn(
      `[gateway] ${GATEWAY_BASE_URL_ENV} ignorada: não é uma URL válida`,
    );
    return null;
  }
}

/**
 * Aponta para o gateway as vars de base URL que o adapter declarou. Muta e
 * devolve o próprio `env` (o agentEnv constrói o objeto do zero por spawn).
 */
export function applyGatewayBaseUrls(
  env: NodeJS.ProcessEnv,
  adapter: {
    readonly id: string;
    readonly env: { readonly passthrough: readonly string[] };
  },
  gatewayBaseUrl: string | null,
): NodeJS.ProcessEnv {
  if (!gatewayBaseUrl) return env;
  for (const key of adapter.env.passthrough) {
    if (!GATEWAY_ROUTABLE_VARS.has(key)) continue;
    env[key] = gatewayBaseUrl;
  }
  return env;
}
