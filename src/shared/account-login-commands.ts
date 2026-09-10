/**
 * Comando de login por CLI para o fluxo "Abrir login da CLI" do vault de
 * contas. O app abre um terminal e dispara este comando; o PRÓPRIO CLI abre o
 * navegador na URL de autenticação do provider — cada um tem a sua, e ela
 * nunca é hardcodeada aqui (o CLI é a fonte de verdade do seu fluxo OAuth).
 *
 * Cobre os adapters com snapshot de sessão suportado
 * (supportsSessionSnapshot): claude + os file-auth de MANAGED_PROVIDER_SPECS
 * + OpenClaude (OAuth próprio em ~/.openclaude) — mais o muse, que tem
 * terminal-login (`muse login`, sessão OAuth em ~/.config/muse/auth.json com
 * segredo no Keychain) mas segue sem snapshot-save (não é file-auth spec).
 * GLM/LongCat autenticam por token injetado (API key) e ficam de fora.
 */
export const ACCOUNT_LOGIN_COMMANDS: Readonly<Record<string, string>> =
  Object.freeze({
    claude: 'claude auth login',
    openclaude: 'openclaude auth login',
    codex: 'codex login',
    grok: 'grok login',
    kimi: 'kimi login',
    opencode: 'opencode auth login',
    muse: 'muse login',
    // AGY inicia o OAuth sozinho quando abre sem sessão.
    agy: 'agy',
    // `devin auth login` tem subcomandos (login/logout/status); o flag
    // --force-manual-token-flow é só para quem não consegue abrir o navegador.
    devin: 'devin auth login',
  });

export function accountLoginCommandFor(adapterId: string): string | null {
  return ACCOUNT_LOGIN_COMMANDS[adapterId] ?? null;
}
