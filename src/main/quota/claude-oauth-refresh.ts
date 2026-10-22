/**
 * Refresh do OAuth de assinatura Claude guardado no VAULT (contas pinadas).
 *
 * O token env (`CLAUDE_CODE_OAUTH_TOKEN`) injetado num pane é um SNAPSHOT do
 * vault: o access token expira em horas e o CLI não refresca token de env —
 * respawn de failover horas depois morria com "401 OAuth access token has
 * expired. Re-authenticate" (caso de campo). Este módulo renova o blob no
 * mesmo rito de kimi-usage/agy-usage (grant_type=refresh_token, client
 * público do Claude Code) para que o spawn sempre encontre token válido.
 *
 * ATENÇÃO à linhagem: refresh ROTACIONA o refresh token no provider. Só é
 * seguro para contas cuja credencial vive APENAS no vault — o chamador nunca
 * deve renovar a conta que é o login nativo do Keychain (o CLI real refresca
 * essa linhagem; rotacionar por fora derrubaria a sessão dele).
 */

export const CLAUDE_OAUTH_TOKEN_URL =
  'https://console.anthropic.com/v1/oauth/token';
/** Client id PÚBLICO do Claude Code (o mesmo do /login do CLI). */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Renova quando faltar menos que isto para expirar (ou sem expiresAt). */
export const CLAUDE_REFRESH_SKEW_MS = 30 * 60 * 1000;
export const CLAUDE_REFRESH_TIMEOUT_MS = 15_000;

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ParsedBlob {
  readonly root: Record<string, unknown>;
  readonly oauth: Record<string, unknown>;
}

function parseBlob(blob: string): ParsedBlob | null {
  try {
    const root: unknown = JSON.parse(blob);
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const oauth = (root as Record<string, unknown>).claudeAiOauth;
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
    return {
      root: root as Record<string, unknown>,
      oauth: oauth as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/**
 * F-1416: o blob ainda pode ser renovado por quem é dono dele (a CLI, sob o
 * `.oauth_refresh.lock`)? Refresh token presente e, quando o blob declara
 * `refreshTokenExpiresAt`, ainda no prazo. Access token vencido com isto
 * verdadeiro NÃO é sessão expirada — é só um token que a CLI renova no
 * próximo uso. Só o relógio do access token nunca prova re-login.
 */
export function claudeBlobIsRenewable(blob: string, now: number): boolean {
  const parsed = parseBlob(blob);
  if (!parsed) return false;
  if (!refreshTokenFrom(parsed)) return false;
  const refreshExpiresAt = parsed.oauth.refreshTokenExpiresAt;
  return !(
    typeof refreshExpiresAt === 'number' &&
    Number.isFinite(refreshExpiresAt) &&
    refreshExpiresAt <= now
  );
}

/**
 * F-1637: access token com `expiresAt` conhecido e já vencido pelo relógio.
 * Distingue "venceu" de "o provedor recusou um token no prazo" (401/403, que
 * também vem de escopo OAuth sem `user:profile`) — só o primeiro, sem refresh
 * token no prazo, prova sessão morta.
 */
export function claudeAccessTokenExpired(blob: string, now: number): boolean {
  const expiresAt = parseBlob(blob)?.oauth.expiresAt;
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now;
}

/**
 * Refresh token do blob quando a renovação é necessária (access token perto
 * de expirar, já expirado, ou sem expiresAt confiável). null = nada a fazer.
 */
export function claudeBlobNeedsRefresh(
  blob: string,
  now: number,
): { refreshToken: string } | null {
  const parsed = parseBlob(blob);
  if (!parsed) return null;
  const refreshToken = refreshTokenFrom(parsed);
  if (!refreshToken) return null;
  const expiresAt = parsed.oauth.expiresAt;
  if (
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt - now > CLAUDE_REFRESH_SKEW_MS
  ) {
    return null;
  }
  return { refreshToken };
}

function refreshTokenFrom(parsed: ParsedBlob): string | null {
  const refreshToken = parsed.oauth.refreshToken;
  return typeof refreshToken === 'string' && refreshToken.length > 0
    ? refreshToken
    : null;
}

/**
 * Access token com expiresAt conhecido e já vencido (além do skew) E sem
 * refresh token utilizável: ninguém consegue renovar este blob — nem o
 * sweeper (`claudeBlobNeedsRefresh` devolve null sem refresh token), nem o
 * CLI (token de env não é refrescado). Escalar este blob para um spawn é
 * 401 garantido queimando uma sessão nova. Sem expiresAt confiável não há
 * juízo (presença continua valendo) — o 401 de runtime com cooldown segue
 * como backstop para expiração indetectável (revogação, rotação externa).
 */
export function claudeBlobIsExpiredUnhealable(
  blob: string,
  now: number,
): boolean {
  const parsed = parseBlob(blob);
  if (!parsed) return false;
  const refreshToken = parsed.oauth.refreshToken;
  if (typeof refreshToken === 'string' && refreshToken.length > 0) return false;
  const expiresAt = parsed.oauth.expiresAt;
  return (
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt - now <= CLAUDE_REFRESH_SKEW_MS
  );
}

/**
 * Renova o blob via token endpoint. Devolve o blob ATUALIZADO (JSON string,
 * refresh token rotacionado preservado) ou null em falha — o chamador mantém
 * o blob antigo e o comportamento fica igual ao de hoje.
 */
export async function refreshClaudeOauthBlob(
  blob: string,
  now: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string | null> {
  const needs = claudeBlobNeedsRefresh(blob, now);
  if (!needs) return null;
  return refreshClaudeOauthBlobWithToken(
    blob,
    now,
    needs.refreshToken,
    fetchImpl,
  );
}

/**
 * Um 401 pode revogar o access token antes de `expiresAt`. Nesse caso a
 * renovação agendada não roda porque o relógio ainda diz "fresco". O caminho
 * forçado usa o refresh token da própria conta e nunca toca no Keychain
 * global; é acionado somente depois de uma falha de autenticação observada.
 */
export async function forceRefreshClaudeOauthBlob(
  blob: string,
  now: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string | null> {
  const parsed = parseBlob(blob);
  if (!parsed) return null;
  const refreshToken = refreshTokenFrom(parsed);
  if (!refreshToken) return null;
  return refreshClaudeOauthBlobWithToken(blob, now, refreshToken, fetchImpl);
}

async function refreshClaudeOauthBlobWithToken(
  blob: string,
  now: number,
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const outcome = await refreshClaudeOauthBlobDetailedWithToken(
    blob,
    now,
    refreshToken,
    fetchImpl,
  );
  return outcome.blob ?? null;
}

/** Resultado discriminado da renovação — 400/401 = grant morto (re-login). */
export interface ClaudeRefreshResult {
  outcome: 'refreshed' | 'invalid-grant' | 'error';
  blob?: string;
}

/**
 * Refresh com distinção de falha: `invalid-grant` só sai de resposta
 * 400/401 do token endpoint (grant revogado/expirado — reautenticar);
 * rede, 429 e 5xx ficam em `error` (transitório — não marca nada).
 * Mesmas regras de linhagem dos wrappers: nunca na conta nativa viva.
 */
export async function refreshClaudeOauthBlobDetailed(
  blob: string,
  now: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ClaudeRefreshResult> {
  const needs = claudeBlobNeedsRefresh(blob, now);
  if (!needs) return { outcome: 'error' };
  return refreshClaudeOauthBlobDetailedWithToken(
    blob,
    now,
    needs.refreshToken,
    fetchImpl,
  );
}

async function refreshClaudeOauthBlobDetailedWithToken(
  blob: string,
  now: number,
  refreshToken: string,
  fetchImpl: FetchLike,
): Promise<ClaudeRefreshResult> {
  const parsed = parseBlob(blob);
  if (!parsed) return { outcome: 'error' };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLAUDE_REFRESH_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CODE_CLIENT_ID,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        outcome:
          response.status === 400 || response.status === 401
            ? 'invalid-grant'
            : 'error',
      };
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') return { outcome: 'error' };
    const data = payload as Record<string, unknown>;
    const accessToken = data.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return { outcome: 'error' };
    }
    const expiresIn = data.expires_in;
    const nextOauth: Record<string, unknown> = {
      ...parsed.oauth,
      accessToken,
      ...(typeof data.refresh_token === 'string' && data.refresh_token.length > 0
        ? { refreshToken: data.refresh_token }
        : {}),
      ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? { expiresAt: now + expiresIn * 1000 }
        : {}),
    };
    return {
      outcome: 'refreshed',
      blob: JSON.stringify({ ...parsed.root, claudeAiOauth: nextOauth }),
    };
  } catch {
    return { outcome: 'error' };
  } finally {
    clearTimeout(timeout);
  }
}
