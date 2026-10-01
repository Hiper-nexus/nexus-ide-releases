import { BILLING_CHANNELS } from '../shared/billing-types';
import { WINDOW_CHANNELS } from '../shared/channels';
import { isStaleLoginCode, loginExchangeMessage, type LoginResultEvent } from '../shared/auth-login';

type Exchange = (code: string, state: string | null) => Promise<{ ok: boolean; error?: string }>;
type Notify = (channel: string, payload?: unknown) => void;

/**
 * Fecha o login que o navegador devolveu por nexus://auth/<code>?state=<nonce>.
 * Além de trocar o code, AVISA a tela: antes a falha só ia para o console e a
 * tela de acesso ficava esperando em silêncio. O renderer recebe texto pronto
 * para a pessoa; o log leva apenas o código da falha (enumerado pelo próprio
 * auth-client), nunca code, state, token nem texto do servidor.
 */
export async function finishAuthDeepLink(
  link: { code: string; state: string | null },
  notify: Notify,
  exchange: Exchange = (code, state) =>
    // Lazy require: auth-client importa electron; mantém este módulo testável.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('./auth-client') as typeof import('./auth-client')).exchangeAuthCode(code, state),
): Promise<void> {
  let result: LoginResultEvent;
  try {
    const outcome = await exchange(link.code, link.state);
    if (outcome.ok) {
      result = { ok: true };
    } else {
      console.warn('[auth] exchange falhou:', outcome.error ?? 'sem-codigo');
      result = {
        ok: false,
        error: loginExchangeMessage(outcome.error),
        ...(isStaleLoginCode(outcome.error) ? { stale: true as const } : {}),
      };
    }
  } catch {
    console.warn('[auth] exchange rejeitou');
    result = { ok: false, error: loginExchangeMessage(undefined) };
  }
  try {
    notify(BILLING_CHANNELS.changed);
    notify(WINDOW_CHANNELS.authLoginResult, result);
  } catch {
    // A janela pode ter fechado durante a troca: a sessão já foi gravada e não
    // há para quem avisar. O chamador usa `void`, então nunca rejeita.
    console.warn('[auth] sem janela para avisar o resultado');
  }
}
