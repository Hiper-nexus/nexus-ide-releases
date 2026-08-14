import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { waitForSession, writeToPane } from '../../terminal/terminal-host';

/**
 * Login de CLI dentro do Nexus: abre um terminal de verdade e roda o comando de
 * login DA FERRAMENTA. O Nexus nunca pede senha nem guarda credencial de
 * assinatura — quem grava a sessão é a própria CLI, igual ao shell do operador.
 *
 * Quando aquele terminal termina, o painel reexamina as CLIs sozinho: é assim
 * que a linha sai de "precisa login" para "conectado" sem o operador caçar botão.
 */

export type CliLoginOutcome =
  | { readonly ok: true; readonly paneId: string }
  | { readonly ok: false; readonly error: string };

/** Tempo máximo observando o terminal de login antes de soltar o watcher. */
const LOGIN_WATCH_TIMEOUT_MS = 15 * 60 * 1000;

export async function openCliLoginTerminal(input: {
  readonly command: string;
  /** Chamado quando o terminal de login encerra (sucesso ou desistência). */
  readonly onFinished?: () => void;
}): Promise<CliLoginOutcome> {
  const command = input.command.trim();
  if (command.length === 0) {
    return { ok: false, error: 'Esta CLI não declara comando de login.' };
  }

  const layout = useLayoutStore.getState();
  const paneId = layout.addShellPane({ focus: false });

  let sessionId: string | null = null;
  try {
    sessionId = await waitForSession(paneId);
  } catch {
    // A cópia de falha abaixo é a única mensagem anunciada ao operador.
  }

  if (!sessionId) {
    layout.close(paneId, 'cli-login-terminal-unavailable');
    return {
      ok: false,
      error: 'O terminal não ficou disponível. O login não foi iniciado.',
    };
  }

  writeToPane(paneId, `${command}\n`);
  useLayoutStore.getState().focus(paneId);
  useProductNavigationStore.getState().openTerminal();

  if (input.onFinished) watchLoginPane(paneId, input.onFinished);
  return { ok: true, paneId };
}

/**
 * Observa UM pane de login até ele morrer ou sumir do layout. Sem polling de
 * credencial: o fim do processo é o sinal, e o painel decide o que reexaminar.
 */
function watchLoginPane(paneId: string, onFinished: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unsubscribeState();
    unsubscribeLayout();
    onFinished();
  };

  const timer = setTimeout(finish, LOGIN_WATCH_TIMEOUT_MS);

  const unsubscribeState = useSessionStateStore.subscribe((state) => {
    if (state.paneStates.get(paneId) === 'exited') finish();
  });

  const unsubscribeLayout = useLayoutStore.subscribe((state) => {
    const stillOpen = listPanes(state.root).some((pane) => pane.id === paneId);
    if (!stillOpen) finish();
  });
}
