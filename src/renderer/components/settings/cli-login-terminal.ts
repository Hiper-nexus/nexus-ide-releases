import { cliLoginAlreadySignedIn, cliLoginLooksComplete } from '../../../shared/cli-login';
import { emailFromAuthDetail } from '../../../shared/auth-detail-identity';
import type { AdapterAuthStatus } from '../../../shared/provider-settings-types';
import { listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { reportLicenseDenial } from '../../state/access-guard';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useProviderStore } from '../../state/provider-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { useToastStore } from '../../state/toast-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { waitForSession, writeToPane } from '../../terminal/terminal-host';
import { kimiLoginCommandFor } from '../../../shared/kimi-login-command';
import { askKimiLoginRegion } from './kimi-login-region';
import { codexDeviceLoginCommand } from '../../../shared/codex-login-command';

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
 * O renderer roda sandboxed (contextIsolation + nodeIntegration:false): não
 * existe `process` na página e ler `process.platform` derrubava TODO login de
 * CLI com "Não foi possível abrir o terminal de login." (F-355). A plataforma
 * vem da ponte `window.nexus.platform` do preload; `process` só entra como
 * fallback fora do Electron (testes).
 */
function rendererPlatform(): NodeJS.Platform | undefined {
  return (typeof window === 'undefined' ? undefined : window.nexus?.platform) ??
    (typeof process === 'undefined' ? undefined : process.platform);
}

/**
 * What the login pane types into the PTY. Kimi `exec`s the CLI so the pane
 * IS `kimi login` (device-code TUI + URL), not a raw shell that happens to
 * run the command (F-354). Codex too: o pane morre junto com a CLI, então ↑ +
 * Enter não roda um segundo `codex login` (que revogaria a conta recém-salva),
 * e `env -u CODEX_HOME` impede que um CODEX_HOME do rc do shell desvie a
 * gravação para fora da vaga que o Main esvaziou. Other CLIs stay typed into
 * the surviving shell.
 */
export function cliLoginTypeLine(input: {
  readonly command: string;
  readonly adapterId?: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? rendererPlatform();
  if (platform === 'win32') return `${input.command}\n`;
  if (input.adapterId === 'codex') return `exec env -u CODEX_HOME ${input.command}\n`;
  if (input.adapterId === 'kimi') return `exec ${input.command}\n`;
  return `${input.command}\n`;
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

/** Rotation alone is not a login: require the login command's success signal too. */
function cliLoginProvedReauthentication(
  baseline: AdapterAuthStatus | null,
  current: AdapterAuthStatus | null,
): boolean {
  return current?.state === 'ok' && Boolean(
    baseline?.sessionFingerprint &&
    baseline.sessionFingerprint === current.sessionFingerprint &&
    baseline.sessionRevision && current.sessionRevision &&
    baseline.sessionRevision !== current.sessionRevision,
  );
}

/** Tempo máximo observando o terminal de login antes de soltar o watcher. */
const LOGIN_WATCH_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_AUTH_POLL_MS = 2_000;

/**
 * O `pty.spawn` no Main exige `requireRendererWorkspaceScope` (pasta de projeto
 * autorizada para a janela) e o `App` só monta `<TerminalWorkspace>` quando
 * `useWorkspaceStore.getState().current` existe. Se o operador abriu
 * Configurações a partir do Launcher (`Início`) ou do assistente inicial sem
 * projeto ativo, reabrimos o projeto mais recente ou pedimos uma pasta antes
 * de criar o pane de login.
 */
async function ensureWorkspaceForLoginTerminal(): Promise<boolean> {
  const ws = useWorkspaceStore.getState();
  if (ws.current) return true;
  if (typeof window === 'undefined' || !window.nexus?.workspace) {
    return true;
  }
  // Recents são WorkspaceInfo (path, name, lastOpenedAt), o mais novo primeiro.
  // `missing` só existe no evento de liveness do workspace aberto, não aqui.
  const recent = ws.recents[0];
  if (recent?.path) {
    try {
      await useWorkspaceStore.getState().open(recent.path);
    } catch {
      // Se a pasta recente falhar, cai para o seletor manual logo abaixo.
    }
  }
  if (!useWorkspaceStore.getState().current) {
    try {
      await useWorkspaceStore.getState().pick();
    } catch {
      // Cancelamento ou erro tratado pela checagem de `current` a seguir.
    }
  }
  return Boolean(useWorkspaceStore.getState().current);
}

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
  /** Only explicit reauthentication of an existing row may accept the same identity. */
  readonly reauthenticate?: boolean;
  /** Chamado quando o login conclui, o pane some, ou o tempo esgota. */
  readonly onFinished?: (finish: CliLoginFinish) => void;
}): Promise<CliLoginOutcome> {
  let command = codexDeviceLoginCommand(input.command, input.adapterId);
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

  if (!(await ensureWorkspaceForLoginTerminal())) {
    return {
      ok: false,
      error:
        'Escolha uma pasta de projeto antes de abrir o terminal de login.',
      cancelled: true,
    };
  }

  // Estado ANTES do terminal: num login de N-ésima conta a CLI JÁ está
  // autenticada, então `authReady` não é evidência do novo login (fecharia o
  // watcher em t=0, antes do OAuth do navegador terminar) — vale a troca de
  // identidade na sonda, a linha de sucesso da CLI ou o fechamento do pane.
  const authReadyAtStart = adapterAuthReady(input.adapterId);

  // Espera o PTY (waitForSession spawna headless). Só então sai de
  // Configurações — senão o operador some da tela antes do login existir.
  const layout = useLayoutStore.getState();
  let paneId: string;
  try {
    paneId = layout.addShellPane({ focus: false });
  } catch (error) {
    // F-228: acesso negado lança LicenseError — toast padrão, sem pane.
    if (!reportLicenseDenial(error)) throw error;
    return { ok: false, error: 'license_access_denied' };
  }
  const paneTitle = `Login ${input.adapterLabel?.trim() || input.adapterId || 'CLI'}`;
  layout.renameTitle(paneId, paneTitle);

  let sessionId: string | null = null;
  try {
    // Sem teto curto próprio: o orçamento é o padrão do terminal-host
    // (SESSION_WAIT_TIMEOUT_MS). No login da 2ª conta o chamador acabou de
    // preservar a sessão viva e disparar o refresh de cotas no Main — as
    // sondas síncronas dessa leva (AGY: descoberta do bridge, scan do
    // binário) concorrem com o spawn deste PTY, e 10 s transformavam
    // "ainda abrindo" em "terminal não ficou disponível" só nesse fluxo.
    sessionId = await waitForSession(paneId);
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
  const slot = isInstalled || !provider ? nativeLoginSlot(input.adapterId) : null;
  let slotPrepared = false;
  try {
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
      if (slot) {
        // Codex sem a ponte de preparo: digitar o login revogaria a conta salva.
        if (!slot.prepare && slot.failClosed) {
          useLayoutStore.getState().close(paneId, 'cli-login-prepare-failed');
          return { ok: false, error: slot.prepareError };
        }
        const prep = await slot.prepare?.();
        if (prep && !prep.ok) {
          useLayoutStore.getState().close(paneId, 'cli-login-prepare-failed');
          return { ok: false, error: prep.error ?? slot.prepareError };
        }
        // Só a vaga que ESTE login esvaziou volta no erro abaixo; um preparo
        // recusado ou que falhou nunca devolve a sessão de outro login.
        slotPrepared = Boolean(prep?.ok);
      }
      writeToPane(
        paneId,
        cliLoginTypeLine({ command, adapterId: input.adapterId }),
      );
    }
  } catch (err) {
    // Sem o comando digitado o pane é um shell órfão chamado "Login X":
    // fecha e devolve erro honesto em vez de propagar para o catch genérico.
    // A sessão que saiu da vaga volta antes de o pane fechar.
    console.warn('[cli-login] comando de login não foi digitado:', err);
    if (slot && slotPrepared) await restoreNativeLoginSlot(slot);
    useLayoutStore.getState().close(paneId, 'cli-login-write-failed');
    return {
      ok: false,
      error:
        'O terminal abriu, mas o comando de login não foi digitado. ' +
        'Tente de novo.',
    };
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
      reauthenticate: input.reauthenticate,
      closePaneOnRelease: input.adapterId === 'codex' && rendererPlatform() === 'win32',
      onFinished: input.onFinished,
    });
  }
  return { ok: true, paneId };
}

interface NativeLoginSlot {
  readonly prepare?: () => Promise<{ ok: boolean; error?: string }>;
  readonly restore?: () => Promise<{ ok: boolean }>;
  readonly prepareError: string;
  /** Sem a ponte de preparo o login não abre. */
  readonly failClosed?: boolean;
  /** A devolução roda em todo desfecho (com login novo na vaga ela só encerra o pendente). */
  readonly restoreOnEveryOutcome?: boolean;
  /** Aviso quando a devolução falha (`ok:false`), em vez de calar. */
  readonly restoreFailure?: { readonly title: string; readonly detail: string };
}

/**
 * CLIs cuja vaga nativa sai vazia antes do login: o Main guarda a sessão atual
 * e a devolve se o login não concluir. AGY: o `/logout` do Google revogaria a
 * conta anterior. Codex: o próprio `codex login` revoga, em
 * auth.openai.com/oauth/revoke, o login que encontra no auth.json — a conta
 * que o Nexus acabou de guardar morria ("logar em uma conta, a outra expira").
 */
function nativeLoginSlot(adapterId: string | undefined): NativeLoginSlot | null {
  const accounts = window.nexus?.accounts;
  if (adapterId === 'agy') {
    return {
      prepare: accounts?.prepareAgyLogin,
      restore: accounts?.restoreAgyLogin,
      prepareError: 'Não foi possível preparar a vaga de login do Antigravity.',
    };
  }
  if (adapterId === 'codex') {
    return {
      prepare: accounts?.prepareCodexLogin,
      restore: accounts?.restoreCodexLogin,
      prepareError: 'Não consegui guardar a sessão atual do Codex. O login não foi iniciado.',
      failClosed: true,
      restoreOnEveryOutcome: true,
      restoreFailure: {
        title: 'Login Codex',
        detail:
          'A sessão anterior não voltou para o ~/.codex desta máquina. A conta continua ' +
          'salva no Nexus; para usar o codex fora do Nexus, entre de novo.',
      },
    };
  }
  return null;
}

/** Devolve a vaga ao fim do login; falha vira aviso, nunca silêncio. */
async function restoreNativeLoginSlot(slot: NativeLoginSlot): Promise<void> {
  let ok = true;
  try {
    const result = await slot.restore?.();
    ok = result ? result.ok : !slot.failClosed;
  } catch {
    ok = false;
  }
  if (!ok && slot.restoreFailure) {
    useToastStore.getState().push('warn', slot.restoreFailure.title, {
      detail: slot.restoreFailure.detail,
      dedupeKey: 'cli-login-restore-failed',
      ttlMs: 20_000,
    });
  }
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
  readonly reauthenticate?: boolean;
  /** Sem `exec` (Windows) o pane segue um shell depois do login: fecha ao soltar. */
  readonly closePaneOnRelease?: boolean;
  readonly onFinished: (finish: CliLoginFinish) => void;
}): void {
  let done = false;
  let probeInFlight = false;
  let probeQueued = false;
  let queuedProbeIsFinal = false;
  let queuedProbeNeedsFreshClaude = false;
  let output = '';
  let signedInNoticed = false;
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
    // Repetir o `codex login` nesse shell revogaria a conta recém-salva.
    if (input.closePaneOnRelease) useLayoutStore.getState().close(input.paneId, 'cli-login-finished');
  };

  /** Sonda desta CLI, ou null quando ela não responde. */
  async function probe(
    freshClaudeCredential = false,
  ): Promise<AdapterAuthStatus | null> {
    try {
      const list = await window.nexus?.providers?.authStatus(
        freshClaudeCredential && input.adapterId === 'claude'
          ? { freshClaudeCredential: true }
          : undefined,
      );
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
  async function probeAndMaybeRelease(
    final: boolean,
    freshClaudeCredential = false,
  ): Promise<void> {
    if (done) return;
    if (probeInFlight) {
      // Uma nova saída pode chegar enquanto a leitura anterior ainda observa
      // o Keychain antigo. Não perca esse edge: refaça assim que ela terminar.
      probeQueued = true;
      queuedProbeIsFinal ||= final;
      queuedProbeNeedsFreshClaude ||= freshClaudeCredential;
      return;
    }
    probeInFlight = true;
    try {
      let status = await probe(freshClaudeCredential);
      const verified = cliLoginProvedNewSession(input.baseline, status) ||
        (input.reauthenticate === true && cliLoginLooksComplete(output) &&
          cliLoginProvedReauthentication(input.baseline, status)) ||
        (input.adapterId === 'agy' && cliLoginLooksComplete(output) && status?.state === 'ok');
      // "Signed in" é só um gatilho para reler. Keychain/auth.json pode ficar
      // visível alguns milissegundos depois da linha impressa; encerrar aqui
      // com `verified:false` perdia para sempre o login recém-concluído.
      if (verified || final) {
        const slot = nativeLoginSlot(input.adapterId);
        if (slot && (!verified || slot.restoreOnEveryOutcome)) {
          await restoreNativeLoginSlot(slot);
          if (!verified) status = (await probe(false)) ?? status;
        }
        release({ verified, status });
      }
    } finally {
      probeInFlight = false;
      if (!done && probeQueued) {
        const nextIsFinal = queuedProbeIsFinal;
        const nextNeedsFreshClaude = queuedProbeNeedsFreshClaude;
        probeQueued = false;
        queuedProbeIsFinal = false;
        queuedProbeNeedsFreshClaude = false;
        void probeAndMaybeRelease(nextIsFinal, nextNeedsFreshClaude);
      }
    }
  }

  const consider = () => {
    if (done) return;
    const stillOpen = listPanes(useLayoutStore.getState().root).some(
      (pane) => pane.id === input.paneId,
    );
    const paneExited =
      useSessionStateStore.getState().paneStates.get(input.paneId) ===
      'exited';
    if (!stillOpen || paneExited) {
      void probeAndMaybeRelease(true);
      return;
    }
    // Login de N-ésima conta: authReady já era true ao abrir — ignorá-lo como
    // sinal, senão o watcher termina antes do novo OAuth existir.
    const authBecameReady =
      !input.authReadyAtStart && adapterAuthReady(input.adapterId);
    const loginLooksComplete = cliLoginLooksComplete(output);
    if (authBecameReady || loginLooksComplete) {
      void probeAndMaybeRelease(false, loginLooksComplete);
    }
    // A CLI avisou que já estava logada: orientar uma vez em vez de calar
    // até o timeout. Não encerra nem prova nada — a troca de sessão (sair
    // e entrar em outra conta) continua sendo a única prova.
    if (!signedInNoticed && cliLoginAlreadySignedIn(output)) {
      signedInNoticed = true;
      useToastStore.getState().push('info', 'A CLI informa que já existe um login ativo.', {
        detail:
          'Para trocar de conta, saia da conta atual na própria CLI (logout) ' +
          'e entre na nova — só a troca de sessão prova o login da outra conta.',
        dedupeKey: `cli-login-signed-in:${input.adapterId ?? 'cli'}`,
        ttlMs: 20_000,
      });
    }
  };

  /**
   * Sinal exclusivo do login de N-ésima conta: a sessão no disco mudou.
   * Sem isto o watcher só soltaria no fechamento do pane, e quem deixa o
   * terminal aberto nunca veria a conta aparecer sozinha.
   */
  async function considerNewSession(): Promise<void> {
    if (done || !input.adapterId) return;
    await probeAndMaybeRelease(false);
  }

  const timer = setTimeout(() => {
    void probeAndMaybeRelease(true);
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
