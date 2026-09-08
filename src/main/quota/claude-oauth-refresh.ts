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

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
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
 * Refresh token do blob quando a renovação é necessária (access token perto
 * de expirar, já expirado, ou sem expiresAt confiável). null = nada a fazer.
 */
export function claudeBlobNeedsRefresh(
  blob: string,
  now: number,
): { refreshToken: string } | null {
  const parsed = parseBlob(blob);
  if (!parsed) return null;
  const refreshToken = parsed.oauth.refreshToken;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null;
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
  const parsed = parseBlob(blob);
  if (!parsed) return null;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: needs.refreshToken,
        client_id: CLAUDE_CODE_CLIENT_ID,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const accessToken = data.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
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
  return JSON.stringify({ ...parsed.root, claudeAiOauth: nextOauth });
}
