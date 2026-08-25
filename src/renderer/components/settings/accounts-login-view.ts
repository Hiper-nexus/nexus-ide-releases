/**
 * IA do painel Contas e login: o que mostrar em cada estado da CLI.
 * Copy e flags juntos para o componente não decidir hierarquia no JSX.
 */

export const LOGIN_CTA_OPEN = 'Abrir login da CLI';
export const LOGIN_CTA_SWITCH = 'Entrar com outra conta';
export const LOGIN_CTA_BUSY = 'Abrindo terminal…';

export function authStatusLabel(state: string | undefined): string {
  if (state === 'ok') return 'conectado';
  if (state === 'missing') return 'precisa login';
  if (state === 'checking') return 'verificando…';
  return 'não verificado';
}

export interface AccountsPanelViewInput {
  readonly authState: string | undefined;
  readonly adapterLabel: string;
  readonly isClaude: boolean;
  readonly vaultCount: number;
  readonly standbyCount: number;
  readonly hasActiveVault: boolean;
  readonly liveEmail: string | null;
  readonly loginCommand: string | null;
  readonly canSnapshot: boolean;
  readonly busy: boolean;
}

export interface AccountsPanelView {
  readonly needsLogin: boolean;
  readonly loggedIn: boolean;
  readonly statusLabel: string;
  readonly hint: string;
  readonly loginCta: string | null;
  readonly showLoginHero: boolean;
  readonly showImplicitNative: boolean;
  readonly showFlatSavedRoster: boolean;
  readonly showSplitRoster: boolean;
  readonly showReserva: boolean;
  readonly showReservaEmpty: boolean;
  readonly showMultiChip: boolean;
  readonly showSaveLoggedIn: boolean;
  readonly showAddAnotherLogin: boolean;
  readonly showActiveEmUsoPill: boolean;
}

export function accountsPanelView(
  input: AccountsPanelViewInput,
): AccountsPanelView {
  const loggedIn = input.authState === 'ok';
  const needsLogin = input.authState === 'missing';
  const checking = input.authState === 'checking';
  const unverified = !loggedIn && !needsLogin && !checking;
  const askLogin = needsLogin || unverified;
  const hasLogin = Boolean(input.loginCommand);
  const vault = input.vaultCount > 0;
  const hasActiveVault = input.hasActiveVault;

  let loginCta: string | null = null;
  if (hasLogin && (askLogin || loggedIn)) {
    loginCta = input.busy
      ? LOGIN_CTA_BUSY
      : askLogin
        ? LOGIN_CTA_OPEN
        : LOGIN_CTA_SWITCH;
  }

  return {
    needsLogin: askLogin,
    loggedIn,
    statusLabel: authStatusLabel(input.authState),
    hint: accountsPanelHint(input, { askLogin, unverified, checking }),
    loginCta,
    showLoginHero: askLogin && hasLogin,
    showImplicitNative: loggedIn && !hasActiveVault,
    showFlatSavedRoster: (askLogin || checking) && vault,
    showSplitRoster: loggedIn && hasActiveVault,
    showReserva: loggedIn && vault,
    showReservaEmpty: loggedIn && hasActiveVault && input.standbyCount === 0,
    showMultiChip: loggedIn && vault,
    showSaveLoggedIn: loggedIn && input.canSnapshot,
    showAddAnotherLogin: loggedIn && hasLogin,
    showActiveEmUsoPill: loggedIn,
  };
}

function accountsPanelHint(
  input: AccountsPanelViewInput,
  flags: {
    readonly askLogin: boolean;
    readonly unverified: boolean;
    readonly checking: boolean;
  },
): string {
  const name = input.adapterLabel.trim() || 'esta CLI';
  if (flags.checking) {
    return `Verificando a sessão de ${name}…`;
  }
  if (!flags.askLogin) {
    return 'A em uso abre o próximo terminal. Reserva entra no failover.';
  }
  const dock = input.isClaude ? ' O app Claude no Dock não conta.' : '';
  if (flags.unverified) {
    return (
      `Não deu para verificar a sessão desta CLI.${dock} ` +
      'Abra o login no terminal se precisar.'
    );
  }
  if (input.vaultCount > 0) {
    return (
      `A CLI ${name} não está logada.${dock} Contas salvas só entram no ` +
      'terminal depois do login.'
    );
  }
  return (
    `A CLI ${name} não está logada.${dock} Abra o login no terminal — ` +
    'o navegador da ferramenta aparece sozinho.'
  );
}
