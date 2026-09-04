import { shouldFinishCliLoginWatch } from '../../../shared/cli-login';
import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useProviderStore } from '../../state/provider-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { waitForSession, writeToPane } from '../../terminal/terminal-host';

/**
 * Login de CLI dentro do Nexus: abre um terminal de verdade e roda o comando de
 * login DA FERRAMENTA. O Nexus nunca pede senha nem guarda credencial de
 * assinatura — quem grava a sessão é a própria CLI, igual ao shell do operador.
 *
 * O comando é digitado num shell. A CLI sai, o prompt volta, o pane continua
 * vivo — então o watcher olha a linha de sucesso e a sonda de sessão, não a
 * morte do processo. Só assim a lista Atenção tira o card "Login" na hora.
 */

export type CliLoginOutcome =
  | { readonly ok: true; readonly paneId: string }
  | { readonly ok: false; readonly error: string };

/** Tempo máximo observando o terminal de login antes de soltar o watcher. */
const LOGIN_WATCH_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_AUTH_POLL_MS = 2_000;

export async function openCliLoginTerminal(input: {
  readonly command: string;
  /** Adapter cuja sessão deve sair de "login-needed" quando o login pegar. */
  readonly adapterId?: string;
  /** Nome visível no título do pane (Claude, Codex…). */
  readonly adapterLabel?: string;
  /** Chamado quando o login conclui, o pane some, ou o tempo esgota. */
  readonly onFinished?: () => void;
}): Promise<CliLoginOutcome> {
  const command = input.command.trim();
  if (command.length === 0) {
    return { ok: false, error: 'Esta CLI não declara comando de login.' };
  }

  // Espera o PTY (waitForSession spawna headless). Só então sai de
  // Configurações — senão o operador some da tela antes do login existir.
  const layout = useLayoutStore.getState();
  const paneId = layout.addShellPane({ focus: false });
  const paneTitle = `Login ${input.adapterLabel?.trim() || input.adapterId || 'CLI'}`;
  layout.renameTitle(paneId, paneTitle);

  let sessionId: string | null = null;
  try {
    sessionId = await waitForSession(paneId, 10_000);
  } catch {
    // A cópia de falha abaixo é a única mensagem anunciada ao operador.
  }

  if (!sessionId) {
    useLayoutStore.getState().close(paneId, 'cli-login-terminal-unavailable');
    return {
      ok: false,
      error: 'O terminal não ficou disponível. O login não foi iniciado.',
    };
  }

  writeToPane(paneId, `${command}\n`);
  useLayoutStore.getState().focus(paneId);
  useProductNavigationStore.getState().openTerminal();

  if (input.onFinished) {
    watchLoginPane({
      paneId,
      sessionId,
      adapterId: input.adapterId,
      onFinished: input.onFinished,
    });
  }
  return { ok: true, paneId };
}

function adapterAuthReady(adapterId: string | undefined): boolean {
  if (!adapterId) return false;
  const provider = useProviderStore
    .getState()
    .providers.find((candidate) => candidate.adapterId === adapterId);
  return (
    provider !== undefined &&
    provider.authStrategy !== 'login-needed'
  );
}

function watchLoginPane(input: {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId?: string;
  readonly onFinished: () => void;
}): void {
  let done = false;
  let output = '';
  let unsubscribeData: (() => void) | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    unsubscribeState();
    unsubscribeLayout();
    unsubscribeData?.();
    input.onFinished();
  };

  const consider = () => {
    const stillOpen = listPanes(useLayoutStore.getState().root).some(
      (pane) => pane.id === input.paneId,
    );
    if (
      shouldFinishCliLoginWatch({
        output,
        paneStillOpen: stillOpen,
        paneExited:
          useSessionStateStore.getState().paneStates.get(input.paneId) ===
          'exited',
        authReady: adapterAuthReady(input.adapterId),
      })
    ) {
      finish();
    }
  };

  const timer = setTimeout(finish, LOGIN_WATCH_TIMEOUT_MS);
  const poll = setInterval(() => {
    void useProviderStore
      .getState()
      .hydrate()
      .then(consider);
  }, LOGIN_AUTH_POLL_MS);

  const unsubscribeState = useSessionStateStore.subscribe(consider);
  const unsubscribeLayout = useLayoutStore.subscribe(consider);
  unsubscribeData = window.nexus?.pty?.onData?.(
    input.sessionId,
    (chunk) => {
      output = (output + chunk).slice(-8_000);
      consider();
    },
  );

  consider();
}
