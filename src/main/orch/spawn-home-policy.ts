import type { CliPtyAdapter } from '../../shared/adapter-types';

type SpawnHomeAdapter = Pick<CliPtyAdapter, 'env' | 'quirks'>;

export type SpawnHomeMode = 'operator-choice' | 'hardened';

export interface SpawnHomePolicyOptions {
  /**
   * O default é deliberadamente Hardened: callers novos não podem afrouxar o
   * isolamento do Claude nativo sem escolher explicitamente o autopiloto.
   */
  readonly mode?: SpawnHomeMode;
  /**
   * Ambiente já resolvido pelo provider/account. Ele cobre Claude-family
   * configurado por endpoint dinâmico, além dos adapters GLM/LongCat estáticos.
   */
  readonly effectiveEnv?: Readonly<Record<string, string>>;
}

export function requiresSpawnGate(meta: {
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly allowedTools?: readonly string[] | null;
  readonly allowedSkills?: readonly string[] | null;
} | null | undefined): boolean {
  return meta?.role === 'orchestrator' ||
    (meta?.allowedTools ?? null) !== null ||
    (meta?.allowedSkills ?? null) !== null;
}

/**
 * HOME efêmero é uma técnica do adapter Claude-like no modo Hardened e para
 * endpoints de terceiro: ele enxerga settings/MCP do Nexus sem herdar hooks
 * globais. No autopiloto, o Claude nativo mantém HOME/Keychain reais; MCP e
 * autoridade continuam confinados à sessão. CLIs como Codex, AGY, Kimi e Grok
 * guardam login no HOME real; trocar HOME nelas quebra auth.
 */
export function shouldUseEphemeralHome(
  adapter: SpawnHomeAdapter,
  gated: boolean,
  options: SpawnHomePolicyOptions = {},
): boolean {
  if (!adapter.quirks.mcpAutoload) return false;

  const isThirdParty = isThirdPartyClaudeFamily(
    adapter,
    options.effectiveEnv,
  );
  if (
    gated &&
    options.mode === 'operator-choice' &&
    !isThirdParty
  ) {
    // O Claude de assinatura precisa do HOME real para preservar Keychain,
    // login e refresh nativos. MCP/autoridade continuam por sessão.
    return false;
  }

  return gated || adapter.env.ephemeralHome;
}

/**
 * Um adapter Claude-family (roda o binário `claude`, mcpAutoload) que aponta
 * para um endpoint DE TERCEIRO via ANTHROPIC_BASE_URL estático (GLM/LongCat)
 * ou resolvido pelo provider/account. Ele autentica por token injetado, então
 * nunca precisa (e nunca pode tocar) o ~/.claude da assinatura nativa.
 * Reutilizar o home real deixaria o binário reescrever o estado OAuth da
 * assinatura e deslogar o usuário (/login); esses adapters recebem um HOME
 * isolado.
 */
export function isThirdPartyClaudeFamily(
  adapter: SpawnHomeAdapter,
  effectiveEnv?: Readonly<Record<string, string>>,
): boolean {
  const baseUrls = [
    effectiveEnv?.ANTHROPIC_BASE_URL,
    adapter.env.static?.ANTHROPIC_BASE_URL,
  ];
  return adapter.quirks.mcpAutoload && baseUrls.some(isThirdPartyBaseUrl);
}

/**
 * Host oficial da Anthropic. Uma `ANTHROPIC_BASE_URL` HERDADA do ambiente
 * apontando para cá não é plano de terceiro — é o Claude nativo com a URL
 * padrão escrita à mão (shells, wrappers de CLI e imagens de CI fazem isso).
 * Tratar presença-de-string como terceiro dava a esse Claude um HOME isolado
 * SEM `carryNativeClaudeAuth` e sem token injetado: a CLI subia sem credencial
 * nenhuma e pedia `/login` no meio da missão, sem nenhum terceiro envolvido.
 */
const NATIVE_ANTHROPIC_HOSTS: ReadonlySet<string> = new Set([
  'api.anthropic.com',
]);

function isThirdPartyBaseUrl(baseUrl: string | undefined): boolean {
  const value = baseUrl?.trim();
  if (!value) return false;
  try {
    return !NATIVE_ANTHROPIC_HOSTS.has(new URL(value).host);
  } catch {
    // URL ilegível conta como terceiro: fail-closed preserva o isolamento em
    // vez de expor a linhagem nativa a um endpoint que não sabemos ler.
    return true;
  }
}
