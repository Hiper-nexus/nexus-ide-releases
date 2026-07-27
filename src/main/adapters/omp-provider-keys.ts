import { loadLauncherProviderKey } from './launcher-provider-manager';
import { ompModelAuthRoute } from './model-auth-readiness';

/**
 * Credencial de API key para um processo OMP.
 *
 * A seleção é provider/model scoped: só a chave do provider do modelo exato
 * pode entrar no ambiente. O comportamento antigo fazia fan-out do vault
 * inteiro para todo processo OMP, aumentando desnecessariamente o alcance de
 * cada worker e permitindo que uma key não escolhida alterasse billing/rota.
 *
 * Fora por design: logins de ASSINATURA (Claude Max, Codex, contas OAuth das
 * outras CLIs). Esses tokens são emitidos para o app que os criou — reusar em
 * outro cliente viola termos e expira sem aviso. Assinatura no omp = login
 * dele mesmo (auth-broker, dirigido pelo painel OMP·RPC).
 *
 * Os aliases/envs aceitos vêm da tabela release-pinned em
 * model-auth-readiness.ts. Provider/model desconhecido falha fechado.
 */

export interface OmpSelectedProviderKey {
  readonly modelProvider: string;
  readonly launcherProviderId: string;
  readonly env: Readonly<Record<string, string>>;
}

export function resolveOmpSelectedProviderKey(
  model: string | null | undefined,
  loadKey: (providerId: string) => string | null = loadLauncherProviderKey,
): OmpSelectedProviderKey | null {
  const route = ompModelAuthRoute(model);
  if (!route?.launcherProviderId || route.envNames.length === 0) return null;
  const key = loadKey(route.launcherProviderId);
  if (!key) return null;
  const env: Record<string, string> = {};
  for (const name of route.envNames) env[name] = key;
  return Object.freeze({
    modelProvider: route.modelProvider,
    launcherProviderId: route.launcherProviderId,
    env: Object.freeze(env),
  });
}

export function hasOmpSelectedProviderKey(
  model: string | null | undefined,
  loadKey: (providerId: string) => string | null = loadLauncherProviderKey,
): boolean {
  return resolveOmpSelectedProviderKey(model, loadKey) !== null;
}

export function buildOmpSelectedProviderKeyEnv(
  model: string | null | undefined,
  loadKey: (providerId: string) => string | null = loadLauncherProviderKey,
): Record<string, string> {
  const selected = resolveOmpSelectedProviderKey(model, loadKey);
  return selected ? { ...selected.env } : {};
}

/**
 * Compatibility name retained for the service while callers migrate. A
 * missing model deliberately returns an empty env, which also guarantees that
 * `auth-broker list/login/token` never receives launcher credentials.
 */
export function buildOmpInheritedKeyEnv(
  model?: string | null,
  loadKey: (providerId: string) => string | null = loadLauncherProviderKey,
): Record<string, string> {
  return buildOmpSelectedProviderKeyEnv(model, loadKey);
}
