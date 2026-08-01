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
 *
 * O gateway é TRANSPORTE, não identidade. Quem decide "que plano é este?"
 * (spawn-home-policy, credencial, HOME) precisa enxergar o env SEM o gateway —
 * ver `agentEnv(adapter, gatewayBaseUrl)` em pty-manager, que constrói o
 * snapshot de identidade passando `null` de propósito. Misturar as duas coisas
 * faz o Claude nativo ser classificado como provider de terceiro e perder a
 * credencial no meio da missão.
 */

export const GATEWAY_BASE_URL_ENV = 'NEXUS_AI_GATEWAY_BASE_URL';

/**
 * Credencial que o próprio gateway exige. Quando ausente, a CLI continua
 * autenticando com a credencial do provider (assinatura/API key) e ela
 * TRAFEGA até o gateway — `gatewayForwardsProviderCredential` existe para
 * tornar isso visível ao operador em vez de silencioso.
 */
export const GATEWAY_API_KEY_ENV = 'NEXUS_AI_GATEWAY_API_KEY';

/** Superfícies de protocolo que um gateway OmniRoute-like expõe. */
const GATEWAY_ROUTABLE_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
]);

/**
 * Var de credencial que cada superfície de protocolo usa. Só é injetada se o
 * adapter TAMBÉM a declarou no passthrough — mesma regra do base URL.
 */
const GATEWAY_CREDENTIAL_VARS: ReadonlyMap<string, string> = new Map([
  ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
  ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
]);

/**
 * Base URLs que existem em adapters mas NÃO são roteadas, com o motivo. Não é
 * esquecimento: `KIMI_MODEL_BASE_URL` é um endpoint de MODELO, amarrado a
 * `KIMI_MODEL_PROVIDER_TYPE` e `KIMI_MODEL_API_KEY` no mesmo trio. Apontar só a
 * URL para o gateway deixaria o trio incoerente (tipo de provider e chave
 * continuariam do modelo antigo), então o Kimi fica fora até que exista uma
 * decisão explícita sobre o trio inteiro.
 *
 * `gemini`, `grok` e `agy` não declaram var de base URL nenhuma — o gateway não
 * tem por onde alcançá-las, e isso é limite da CLI, não do Nexus.
 */
export const GATEWAY_OUT_OF_REACH_VARS: ReadonlyMap<string, string> = new Map([
  [
    'KIMI_MODEL_BASE_URL',
    'endpoint de modelo (amarrado a KIMI_MODEL_PROVIDER_TYPE/API_KEY)',
  ],
]);

/** Valida e normaliza uma base URL de gateway venha ela de env ou das settings. */
export function normalizeGatewayBaseUrl(
  raw: string | undefined | null,
  origin = GATEWAY_BASE_URL_ENV,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(
        `[gateway] ${origin} ignorada: protocolo ` +
          `${parsed.protocol} não é http(s)`,
      );
      return null;
    }
    return value.replace(/\/+$/, '');
  } catch {
    console.warn(`[gateway] ${origin} ignorada: não é uma URL válida`);
    return null;
  }
}

export function resolveGatewayBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return normalizeGatewayBaseUrl(env[GATEWAY_BASE_URL_ENV]);
}

export function resolveGatewayApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env[GATEWAY_API_KEY_ENV]?.trim() || null;
}

/** Vars que o gateway efetivamente reescreve para este adapter. */
export function gatewayRoutedVars(adapter: {
  readonly env: { readonly passthrough: readonly string[] };
}): string[] {
  return adapter.env.passthrough.filter((key) =>
    GATEWAY_ROUTABLE_VARS.has(key),
  );
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
  for (const key of gatewayRoutedVars(adapter)) {
    env[key] = gatewayBaseUrl;
  }
  return env;
}

/**
 * Injeta a credencial DO GATEWAY nas vars de chave que o adapter declarou —
 * aplicada DEPOIS do keyEnv do provider de propósito: se o operador configurou
 * uma chave de gateway, é ela que autentica o tráfego que agora vai para lá.
 * Sem chave configurada, nada é tocado (a credencial do provider segue valendo).
 */
export function applyGatewayCredential(
  env: NodeJS.ProcessEnv,
  adapter: {
    readonly id: string;
    readonly env: { readonly passthrough: readonly string[] };
  },
  gatewayBaseUrl: string | null,
  gatewayApiKey: string | null,
): NodeJS.ProcessEnv {
  if (!gatewayBaseUrl || !gatewayApiKey) return env;
  for (const routed of gatewayRoutedVars(adapter)) {
    const credentialVar = GATEWAY_CREDENTIAL_VARS.get(routed);
    // Mesma doutrina do base URL: só uma var que a CLI declarou conhecer.
    if (!credentialVar) continue;
    if (!adapter.env.passthrough.includes(credentialVar)) continue;
    env[credentialVar] = gatewayApiKey;
  }
  return env;
}

/**
 * O spawn vai mandar a credencial do PROVIDER (assinatura OAuth ou API key da
 * conta) para um endpoint que não é do provider. É o comportamento correto para
 * um gateway local do próprio operador, mas precisa ser dito em voz alta — o
 * resto do código trata base URL estrangeira como fronteira de confiança.
 */
export function gatewayForwardsProviderCredential(
  adapter: {
    readonly env: { readonly passthrough: readonly string[] };
  },
  gatewayBaseUrl: string | null,
  gatewayApiKey: string | null,
): boolean {
  if (!gatewayBaseUrl || gatewayApiKey) return false;
  return gatewayRoutedVars(adapter).length > 0;
}
