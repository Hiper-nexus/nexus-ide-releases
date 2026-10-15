/**
 * F-684: devolve ao perfil de origem, DURANTE a vida do pane, o auth.json que
 * uma CLI de refresh rotativo renovou dentro do overlay.
 *
 * O overlay liga o auth.json de origem (symlink no POSIX, hardlink ou cópia no
 * Windows). CLIs como o Grok regravam o arquivo por temporário + rename: o
 * vínculo se desfaz e o token renovado passa a existir só no overlay. Como o
 * refresh token ROTACIONA, a origem fica com um token que o servidor já
 * invalidou — no Windows o ~/.grok/auth.json parou em 22/09 e o operador
 * precisava logar todo dia (29/09). A devolução do fechamento só rodava em
 * pane direto, perdia-se em reinício do app e copiava sem olhar validade
 * (o último a fechar sobrescrevia um token mais novo).
 *
 * Regra: grava na origem só o blob da MESMA conta (ou origem vazia/vencida) e
 * mais novo que o da origem — nunca um mais velho, nunca por cima do login
 * válido de outra conta. A gravação é NO PRÓPRIO arquivo (sem rename) para os
 * outros panes que ainda compartilham o hardlink enxergarem o token novo.
 *
 * F-1485: no Windows a gravação na origem pode ser recusada por um instante
 * (EPERM/EBUSY: antivírus, indexador, outro processo com o arquivo aberto). A
 * passada que falha fica pendente e é refeita a cada volta do vigia — antes ela
 * só voltava quando o overlay mudasse de novo, o que depois da renovação não
 * acontece — e, no fechamento, é regravada da memória até a origem aceitar. O
 * vigia só devolve a conta do pane (a da origem no spawn) e, com
 * `verifyDestination`, grava pelo descritor depois de conferir o destino antes
 * e depois de abrir (nada de escrever através de link plantado no meio).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Tentativas da pendência depois que o pane fechou (uma por volta do vigia). */
const DETACHED_RETRIES = 5;

export interface AuthWriteThroughPolicy {
  /** Maior validade (epoch ms) do blob; null quando ilegível/sem data. */
  expiry(blob: string): number | null;
  /** Identidades estáveis da conta (sujeito/e-mail), minúsculas. */
  identities(blob: string): readonly string[];
}

export type AuthWriteThroughDecision = 'write' | 'skip';

export function decideAuthWriteThrough(
  overlayBlob: string,
  sourceBlob: string | null,
  policy: AuthWriteThroughPolicy,
  now = Date.now(),
): AuthWriteThroughDecision {
  if (overlayBlob === sourceBlob) return 'skip';
  const overlayExpiry = policy.expiry(overlayBlob);
  const overlayIds = policy.identities(overlayBlob);
  if (overlayExpiry === null || overlayIds.length === 0) return 'skip';
  if (!sourceBlob) return 'write';
  const sourceIds = policy.identities(sourceBlob);
  const sourceExpiry = policy.expiry(sourceBlob);
  if (sourceIds.length === 0 || sourceExpiry === null) return 'write';
  const sameAccount = overlayIds.some((id) => sourceIds.includes(id));
  if (!sameAccount) {
    // Login de outra conta no pane só substitui uma origem já vencida.
    return sourceExpiry <= now && overlayExpiry > now ? 'write' : 'skip';
  }
  return overlayExpiry > sourceExpiry ? 'write' : 'skip';
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.ino === b.ino && a.dev === b.dev && a.ino !== 0;
  } catch {
    return false;
  }
}

/** 'failed': a regra mandou gravar e a origem recusou (fica pendente). */
type BlobWriteResult = 'written' | 'skipped' | 'failed';

class DestinationRefused extends Error {}

/**
 * Grava no próprio arquivo (mesmo inode: os hardlinks dos outros panes veem o
 * token). Com `verify`, confere o destino antes de abrir e, de novo, depois:
 * o descritor aberto tem de ser o arquivo comum que está no caminho conferido.
 * Arquivo ausente nasce com `wx` (nunca segue um link plantado no lugar).
 */
function writeInPlace(file: string, blob: string, verify?: (file: string) => boolean): void {
  if (verify && !verify(file)) throw new DestinationRefused();
  const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'wx', 0o600);
  try {
    if (verify) {
      const opened = fs.fstatSync(fd);
      const onPath = fs.lstatSync(file);
      if (!verify(file) || !onPath.isFile() || opened.ino !== onPath.ino || opened.dev !== onPath.dev) {
        throw new DestinationRefused();
      }
    }
    const data = Buffer.from(blob, 'utf8');
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.ftruncateSync(fd, data.length);
  } finally {
    fs.closeSync(fd);
  }
}

function writeBlobThrough(
  overlayBlob: string,
  sourceFile: string,
  policy: AuthWriteThroughPolicy,
  now: number,
  verify?: (file: string) => boolean,
): BlobWriteResult {
  const sourceBlob = readText(sourceFile);
  if (decideAuthWriteThrough(overlayBlob, sourceBlob, policy, now) !== 'write') {
    return 'skipped';
  }
  try {
    writeInPlace(sourceFile, overlayBlob, verify);
    return 'written';
  } catch (error) {
    return error instanceof DestinationRefused ? 'skipped' : 'failed';
  }
}

/** Uma passada: devolve o blob do overlay à origem quando a regra manda. */
export function writeThroughOnce(
  overlayFile: string,
  sourceFile: string,
  policy: AuthWriteThroughPolicy,
  now = Date.now(),
): boolean {
  if (sameFile(overlayFile, sourceFile)) return false;
  const overlayBlob = readText(overlayFile);
  if (!overlayBlob) return false;
  return writeBlobThrough(overlayBlob, sourceFile, policy, now) === 'written';
}

function statSignature(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

/**
 * F-1485: a devolução só leva a conta do pane. `paneAccount` é a da origem no
 * spawn; com ela vazia (pane nasceu sem credencial) só preenche origem vazia.
 * A origem, se legível, também tem de ser da conta do pane: login de OUTRA
 * conta no pane nunca troca a conta da origem (use `grok login` para trocar).
 */
function withinPaneAccount(
  blob: string,
  sourceFile: string,
  paneAccount: readonly string[],
  policy: AuthWriteThroughPolicy,
): boolean {
  const sourceBlob = readText(sourceFile);
  if (paneAccount.length === 0) return !sourceBlob;
  const sourceIds = sourceBlob ? policy.identities(sourceBlob) : [];
  return policy.identities(blob).some((id) => paneAccount.includes(id)) &&
    (sourceIds.length === 0 || sourceIds.some((id) => paneAccount.includes(id)));
}

/** Pendência do fechamento: o overlay já sumiu, o blob segue na memória. */
function retryDetached(
  attempt: () => BlobWriteResult,
  intervalMs: number,
  attemptsLeft: number,
): void {
  const timer = setTimeout(() => {
    let result: BlobWriteResult = 'failed';
    try {
      result = attempt();
    } catch {
      // Conta como falha: tenta de novo na próxima volta.
    }
    if (result === 'failed' && attemptsLeft > 1) {
      retryDetached(attempt, intervalMs, attemptsLeft - 1);
    }
  }, intervalMs);
  timer.unref?.();
}

/**
 * Vigia o auth.json do overlay e devolve cada renovação. O disposer faz a
 * última passada (fechamento do pane) antes de parar de vigiar.
 */
export function startAuthWriteThrough(input: {
  readonly overlayFile: string;
  readonly sourceFile: string;
  readonly policy: AuthWriteThroughPolicy;
  readonly intervalMs?: number;
  /** Confinamento físico do destino, conferido antes e depois de abrir. */
  readonly verifyDestination?: (sourceFile: string) => boolean;
}): () => void {
  const intervalMs = input.intervalMs ?? 2_000;
  const sourceAtSpawn = readText(input.sourceFile);
  const paneAccount = sourceAtSpawn ? input.policy.identities(sourceAtSpawn) : [];
  const attempt = (blob: string): BlobWriteResult =>
    withinPaneAccount(blob, input.sourceFile, paneAccount, input.policy)
      ? writeBlobThrough(blob, input.sourceFile, input.policy, Date.now(), input.verifyDestination)
      : 'skipped';
  let pending: string | null = null;
  const tick = (): void => {
    try {
      if (sameFile(input.overlayFile, input.sourceFile)) {
        pending = null;
        return;
      }
      const blob = readText(input.overlayFile) ?? pending;
      if (!blob) return;
      pending = attempt(blob) === 'failed' ? blob : null;
    } catch {
      // Best effort: nunca derruba o pane por uma devolução falha.
    }
  };
  let seen = statSignature(input.overlayFile);
  const check = (): void => {
    const current = statSignature(input.overlayFile);
    if (current === seen && pending === null) return;
    seen = current;
    tick();
  };
  // A passada que falhou fica pendente e é refeita a cada intervalMs mesmo sem
  // nova mudança no overlay (F-1485); sem pendência o temporizador desarma.
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const disarmRetry = (): void => {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
  };
  const wake = (): void => {
    check();
    if (pollTimer) return;
    if (pending === null) disarmRetry();
    else if (!retryTimer) {
      retryTimer = setInterval(wake, intervalMs);
      retryTimer.unref?.();
    }
  };
  const armPoll = (): void => {
    if (pollTimer) return;
    pollTimer = setInterval(wake, intervalMs);
    pollTimer.unref?.();
  };
  // O acordar é por fs.watch na PASTA (a CLI regrava por temporário + rename, o
  // que troca o inode do arquivo vigiado); o poll por statSync fica só de
  // reserva para quando o watch falha ou é recusado.
  let watcher: fs.FSWatcher | null = null;
  const overlayBase = path.basename(input.overlayFile);
  try {
    watcher = fs.watch(path.dirname(input.overlayFile), { persistent: false }, (_event, filename) => {
      if (filename !== null && filename.toString() !== overlayBase) return;
      wake();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
      armPoll();
    });
  } catch {
    watcher = null;
    armPoll();
  }
  return () => {
    watcher?.close();
    if (pollTimer) clearInterval(pollTimer);
    disarmRetry();
    tick();
    if (pending !== null) {
      const blob = pending;
      pending = null;
      retryDetached(() => attempt(blob), intervalMs, DETACHED_RETRIES);
    }
  };
}
