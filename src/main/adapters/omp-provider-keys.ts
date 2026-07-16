import { loadLauncherProviderKey } from './launcher-provider-manager';

/**
 * Herança de chaves para o omp: as API keys que o usuário JÁ guardou no Nexus
 * (providers.conf do launcher — GLM, Moonshot, DeepSeek, OpenRouter…) são
 * injetadas no processo do omp com os nomes de env que ele reconhece — o omp
 * nasce funcionando sem novo login.
 *
 * Fora por design: logins de ASSINATURA (Claude Max, Codex, contas OAuth das
 * outras CLIs). Esses tokens são emitidos para o app que os criou — reusar em
 * outro cliente viola termos e expira sem aviso. Assinatura no omp = /login
 * dele mesmo.
 *
 * Só entram no env as chaves que EXISTEM — nunca variáveis vazias, e nomes
 * desconhecidos pelo omp são ignorados por ele sem efeito colateral.
 */

/** upstream do Nexus → nomes de env que o omp/SDKs reconhecem. */
const UPSTREAM_TO_OMP_ENV: ReadonlyArray<readonly [string, readonly string[]]> =
  Object.freeze([
    ['anthropic', ['ANTHROPIC_API_KEY']],
    // z.ai aparece nos SDKs com os dois nomes; injetar ambos é inócuo.
    ['glm', ['ZAI_API_KEY', 'ZHIPUAI_API_KEY']],
    ['moonshot', ['MOONSHOT_API_KEY']],
    ['deepseek', ['DEEPSEEK_API_KEY']],
    ['minimax', ['MINIMAX_API_KEY']],
    ['qwen', ['DASHSCOPE_API_KEY']],
    ['openrouter', ['OPENROUTER_API_KEY']],
  ]);

export function buildOmpInheritedKeyEnv(
  loadKey: (providerId: string) => string | null = loadLauncherProviderKey,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [upstream, envNames] of UPSTREAM_TO_OMP_ENV) {
    const key = loadKey(upstream);
    if (!key) continue;
    for (const name of envNames) env[name] = key;
  }
  return env;
}
