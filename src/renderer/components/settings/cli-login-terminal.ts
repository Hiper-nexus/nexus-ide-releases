import { shouldFinishCliLoginWatch } from '../../../shared/cli-login';
import { emailFromAuthDetail } from '../../../shared/auth-detail-identity';
import type { AdapterAuthStatus } from '../../../shared/provider-settings-types';
import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useProviderStore } from '../../state/provider-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { waitForSession, writeToPane } from '../../terminal/terminal-host';
import { kimiLoginCommandFor } from '../../../shared/kimi-login-command';
import { askKimiLoginRegion } from './kimi-login-region';

/**
 * Aspas simples POSIX, sempre — deliberadamente sem a variante condicional do
 * `shellQuote` do terminal-host, que só cita ao encontrar caractere especial e
 * deixa passar `~` e `#`.
 *
 * Dentro de '...' o shell não interpreta nada: nem `$`, nem crase, nem barra
 * invertida. É o que separa "mostrar um comando sugerido" de "executar o que
 * veio no campo `installCommand`" — o texto aqui é dado, não instrução.
 */
function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
  | { readonly ok: false; readonly error: string; readonly cancelled?: boolean };

/**
 * What the login pane types into the PTY. Kimi `exec`s the CLI so the pane
 * IS `kimi login` (device-code TUI + URL), not a raw shell that happens to
 * run the command (F-354). Other CLIs stay typed into the surviving shell.
 */
export function cliLoginTypeLine(input: {
  readonly command: string;
  readonly adapterId?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const replaceShell = input.adapterId === 'kimi' && platform !== 'win32';
  return replaceShell ? `exec ${input.command}\n` : `${input.command}\n`;
}

/**
 * O que o terminal de login provou quando o watcher soltou.
 *
 * `verified` é a ÚNICA autorização para gravar uma conta nova. Fechar o pane,
 * estourar o tempo ou reencontrar uma CLI que já estava autenticada não
 * provam login nenhum — provariam "sucesso" em cima de um cancelamento.
 */
export interface CliLoginFinish {
  readonly verified: boolean;
  /** Estado observado ao soltar; alimenta o rótulo e o aviso honesto. */
  readonly status: AdapterAuthStatus | null;
}

/**
 * Identidade opaca da sessão que está no disco AGORA. Só igualdade: nunca é
 * exibida, registrada nem persistida. O fingerprint do motor vem primeiro
 * porque existe em CLI que não expõe e-mail nenhum (Kimi, OpenCode); o e-mail
 * é o segundo caminho, para provider que expõe identidade mas não fingerprint.
 */
function sessionIdentity(
  status: AdapterAuthStatus | null | undefined,
): string | null {
  const fingerprint = status?.sessionFingerprint?.trim();
  if (fingerprint) return `fp:${fingerprint}`;
  const email = emailFromAuthDetail(status?.detail);
  return email ? `em:${email.trim().toLowerCase()}` : null;
}

/**
 * Houve LOGIN NOVO entre o baseline (colhido antes de abrir o terminal) e o
 * estado atual?
 *
 * Duas provas, nesta ordem:
 * 1. não havia sessão e agora há — transição honesta de `missing`/`unknown`
 *    para `ok`;
 * 2. havia sessão e a identidade da sessão MUDOU (fingerprint surgiu/mudou,
 *    ou o e-mail trocou).
 *
 * Sem identidade nos dois lados não dá para provar nada, e o honesto é dizer
 * que não deu — não gravar uma conta que talvez seja a mesma de antes.
 */
export function cliLoginProvedNewSession(
  baseline: AdapterAuthStatus | null | undefined,
  current: AdapterAuthStatus | null | undefined,
): boolean {
  if (current?.state !== 'ok') return false;
  if (baseline?.state !== 'ok') return true;
  const after = sessionIdentity(current);
  if (!after) return false;
  return after !== sessionIdentity(baseline);
}

/** Tempo máximo observando o terminal de login antes de soltar o watcher. */
const LOGIN_WATCH_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_AUTH_POLL_MS = 2_000;

export async function openCliLoginTerminal(input: {
  readonly command: string;
  /** Adapter cuja sessão deve sair de "login-needed" quando o login pegar. */
  readonly adapterId?: string;
  /** Nome visível no título do pane (Claude, Codex…). */
  readonly adapterLabel?: string;
  /**
   * Sessão observada ANTES de abrir o login. É a régua contra a qual o
   * watcher prova que houve login novo; quem chama colhe uma sonda fresca
   * primeiro justamente para o baseline não ser uma leitura velha.
   */
  readonly baseline?: AdapterAuthStatus | null;
  /** Chamado quando o login conclui, o pane some, ou o tempo esgota. */
  readonly onFinished?: (finish: CliLoginFinish) => void;
}): Promise<CliLoginOutcome> {
  let command = input.command.trim();
  if (input.adapterId === 'kimi') {
    const region = await askKimiLoginRegion();
    if (!region) {
      return { ok: false, error: 'Login cancelado.', cancelled: true };
    }
    command = kimiLoginCommandFor(region);
  }
  if (command.length === 0) {
    return { ok: false, error: 'Esta CLI não declara comando de login.' };
  }

  // Estado ANTES do terminal: num login de N-ésima conta a CLI JÁ está
  // autenticada, então `authReady` não é evidência do novo login (fecharia o
  // watcher em t=0, antes do OAuth do navegador terminar) — vale a troca de
  // identidade na sonda, a linha de sucesso da CLI ou o fechamento do pane.
  const authReadyAtStart = adapterAuthReady(input.adapterId);

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

  const provider = input.adapterId
    ? useProviderStore
        .getState()
        .providers.find((candidate) => candidate.adapterId === input.adapterId)
    : undefined;
  const isInstalled = provider ? provider.installed : true;
  if (!isInstalled && provider) {
    const installCmd =
      provider.installCommand ||
      `consulte a documentação para instalar a CLI ${provider.label}`;
    const safeMsg = `⚠️ A CLI '${provider.label || input.adapterId}' não foi encontrada no PATH.`;
    const safeCmdMsg = `Instalação sugerida: ${installCmd}`;
    const tipMsg = 'Execute o comando acima neste terminal para instalar a CLI.';
    writeToPane(
      paneId,
      `printf '%s\\n%s\\n%s\\n\\n' ${posixSingleQuote(safeMsg)} ${posixSingleQuote(safeCmdMsg)} ${posixSingleQuote(tipMsg)}\n`,
    );
  } else {
    writeToPane(
      paneId,
      cliLoginTypeLine({ command, adapterId: input.adapterId }),
    );
  }
  useLayoutStore.getState().focus(paneId);
  useProductNavigationStore.getState().openTerminal();

  if (input.onFinished) {
    watchLoginPane({
      paneId,
      sessionId,
      adapterId: input.adapterId,
      authReadyAtStart,
      baseline: input.baseline ?? null,
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
  /** CLI já autenticada ao abrir o terminal (login de N-ésima conta). */
  readonly authReadyAtStart: boolean;
  readonly baseline: AdapterAuthStatus | null;
  readonly onFinished: (finish: CliLoginFinish) => void;
}): void {
  let done = false;
  let output = '';
  let unsubscribeData: (() => void) | undefined;

  const release = (finish: CliLoginFinish) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    unsubscribeState();
    unsubscribeLayout();
    unsubscribeData?.();
    input.onFinished(finish);
  };

  /** Sonda desta CLI, ou null quando ela não responde. */
  async function probe(): Promise<AdapterAuthStatus | null> {
    try {
      const list = await window.nexus?.providers?.authStatus();
      return list?.find((s) => s.adapterId === input.adapterId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Todo caminho de encerramento passa por aqui: o pane fechou, a CLI
   * imprimiu a linha de sucesso, ou o tempo estourou. Nenhum desses sinais é
   * prova de login — a prova é a sonda, comparada com o baseline. Assim
   * cancelar não vira conta nova, e concluir sem fechar o pane também conta.
   */
  async function releaseAfterProbe(): Promise<void> {
    if (done) return;
    const status = await probe();
    release({
      verified: cliLoginProvedNewSession(input.baseline, status),
      status,
    });
  }

  const consider = () => {
    if (done) return;
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
        // Login de N-ésima conta: authReady já era true ao abrir — ignorá-lo
        // como sinal, senão o watcher "termina" antes do novo OAuth existir.
        authReady: input.authReadyAtStart
          ? false
          : adapterAuthReady(input.adapterId),
      })
    ) {
      void releaseAfterProbe();
    }
  };

  /**
   * Sinal exclusivo do login de N-ésima conta: a sessão no disco mudou.
   * Sem isto o watcher só soltaria no fechamento do pane, e quem deixa o
   * terminal aberto nunca veria a conta aparecer sozinha.
   */
  async function considerNewSession(): Promise<void> {
    if (done || !input.adapterId) return;
    const status = await probe();
    if (done) return;
    if (cliLoginProvedNewSession(input.baseline, status)) {
      release({ verified: true, status });
    }
  }

  const timer = setTimeout(() => {
    void releaseAfterProbe();
  }, LOGIN_WATCH_TIMEOUT_MS);
  const poll = setInterval(() => {
    void useProviderStore
      .getState()
      .hydrate()
      .then(consider);
    void considerNewSession();
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
  void considerNewSession();
}
