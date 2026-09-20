import type { CliPtyAdapter } from '../../shared/adapter-types';

type SpawnHomeAdapter = Pick<CliPtyAdapter, 'env' | 'quirks'> & { readonly bin?: string };

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
 * HOME com layout `~/.claude.json` / `.claude/`. mcpAutoload still means
 * Claude Code for fixtures and GLM/LongCat. OpenClaude autoloads MCP too
 * but stores session in `~/.openclaude` — a Claude overlay logs it out.
 */
function spawnBinName(adapter: SpawnHomeAdapter): string {
  return adapter.bin?.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? '';
}

export function usesClaudeHomeLayout(adapter: SpawnHomeAdapter): boolean {
  const bin = spawnBinName(adapter);
  if (bin === 'openclaude') return false;
  if (bin === 'claude') return true;
  // Fixtures and GLM-like adapters may omit `bin` and only set mcpAutoload.
  // A real non-Claude binary (muse, kimi, grok, …) must never inherit Claude
  // HOME just because someone copied `mcpAutoload: true` into the adapter.
  if (!bin) return adapter.quirks.mcpAutoload === true;
  return false;
}

/**
 * `--mcp-config` / `--settings` / `--strict-mcp-config` are Claude Code
 * flags. OpenClaude accepts them too. Muse/Kimi/Codex dump `--help` and
 * exit 2 if they appear on argv (F-596).
 */
export function acceptsClaudeMcpCliFlags(adapter: SpawnHomeAdapter): boolean {
  const bin = spawnBinName(adapter);
  if (bin === 'claude' || bin === 'openclaude') return true;
  if (!bin) return adapter.quirks.mcpAutoload === true;
  return false;
}

/**
 * Selects the gated settings profile inside the private Claude-family HOME.
 * F-567 also gives direct/operator-choice panes a private HOME for conversation
 * isolation, while carrying native auth and their existing profile policy.
 * Other providers retain their own home policy.
 */
export function shouldUseEphemeralHome(
  adapter: SpawnHomeAdapter,
  gated: boolean,
  options: SpawnHomePolicyOptions = {},
): boolean {
  // Lei física do binário: ver isThirdPartyClaudeFamily — bin `claude`
  // terceiro precisa do mesmo tratamento de home da família.
  if (!usesClaudeHomeLayout(adapter)) return false;

  const isThirdParty = isThirdPartyClaudeFamily(
    adapter,
    options.effectiveEnv,
  );
  if (
    gated &&
    options.mode === 'operator-choice' &&
    !isThirdParty
  ) {
    // Operator-choice retains native profile settings/auth, projected into
    // a private HOME by mcp-server; it does not enable the gated hooks.
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
  // Lei física do binário (bug E, 2026-08-17): adapter de usuário com bin
  // `claude` apontando para endpoint terceiro (deepseek/qwen/sakana…) podia
  // declarar mcpAutoload false — nascia sem MCP e sem HOME isolado, e o
  // binário reescrevia o OAuth da assinatura nativa. Se roda o binário
  // claude contra terceiro, É família Claude terceira. mcpAutoload sozinho
  // não basta: OpenClaude também autoload MCP e NÃO é layout ~/.claude.
  return usesClaudeHomeLayout(adapter) && baseUrls.some(isThirdPartyBaseUrl);
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
