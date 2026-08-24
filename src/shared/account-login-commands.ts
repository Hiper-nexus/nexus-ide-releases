/**
 * Comando de login por CLI para o fluxo "Entrar com nova conta" do vault de
 * contas. O app abre um terminal e dispara este comando; o PRÓPRIO CLI abre o
 * navegador na URL de autenticação do provider — cada um tem a sua, e ela
 * nunca é hardcodeada aqui (o CLI é a fonte de verdade do seu fluxo OAuth).
 *
 * Cobre exatamente os adapters com snapshot de sessão suportado
 * (supportsSessionSnapshot): claude + os file-auth de MANAGED_PROVIDER_SPECS
 * + OpenClaude (OAuth próprio em ~/.openclaude).
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
    // AGY inicia o OAuth sozinho quando abre sem sessão.
    agy: 'agy',
  });

export function accountLoginCommandFor(adapterId: string): string | null {
  return ACCOUNT_LOGIN_COMMANDS[adapterId] ?? null;
}
