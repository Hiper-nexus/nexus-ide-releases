/**
 * Git (status + diff) e arquivos (lista + leitura) do checkout de UM pane,
 * para o celular pela Remote Bridge (F-1014). Só leitura: nada aqui faz
 * stage, commit, checkout ou escrita, e nada digita no PTY do pane.
 *
 * Autoridade, nesta ordem, a cada pedido:
 *  1. o aparelho já passou pela autenticação da bridge (token + chave);
 *  2. o pane pedido existe e o escopo do aparelho pode LÊ-LO
 *     (`authorizePaneAccess`, a mesma regra de `pane.read`);
 *  3. a raiz é o checkout DO PANE (`executionScope` de um worker em worktree,
 *     senão o escopo do pane), resolvida com `realpath` e conferida contra o
 *     caminho que o Main registrou — nunca um caminho vindo do aparelho;
 *  4. o caminho pedido é relativo, sem `..`, fora de `.git/` e de arquivos de
 *     segredo (o mesmo `SECRET_BASENAME_PATTERN` da orientação), e cada
 *     componente que existir e for link simbólico precisa resolver
 *     (`realpath`) para dentro da raiz real.
 *
 * Os serviços são os do desktop: `gitScmStatus`/`gitFileDiff` (painel Git,
 * runner endurecido: sem hooks/fsmonitor/driver externo de diff), `listDir`
 * (explorador de arquivos) e `openWorkspaceFileForRead` (leitura presa ao
 * descritor, sem seguir links nem hardlinks) — que continuam valendo como
 * segunda camada atrás do guarda de caminho daqui.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GitFileChange } from '../../shared/git-scm';
import type { ProjectExecutionScope } from '../../shared/types';
import { SECRET_BASENAME_PATTERN } from '../context/orientation/orientation-types';
import { gitFileDiff, gitScmStatus } from '../integrations/git-workspace';
import { authorizePaneAccess } from '../orch/pane-authz';
import { getPaneAuthzInfo } from '../orch/pane-registry';
import { openWorkspaceFileForRead } from '../orch/workspace-file';
import { listDir, looksBinary } from '../persistence/files-ipc';

/** Leitura de arquivo: acima disto o conteúdo vem cortado com `truncated: true`. */
export const REMOTE_FILE_READ_MAX_BYTES = 256 * 1024;
/** Diff de um arquivo: acima disto o patch vem cortado com `truncated: true`. */
export const REMOTE_DIFF_MAX_CHARS = 256 * 1024;
/** Entradas por pasta na listagem. */
export const REMOTE_LIST_MAX_ENTRIES = 1_000;
const MAX_PATH_CHARS = 4_096;
const MAX_ERROR_CHARS = 240;

export interface RemotePaneWorkspace {
  readonly paneId: string;
  readonly scope: ProjectExecutionScope;
  /** `realpath` da raiz do checkout do pane. */
  readonly root: string;
}

function refuse(reason: string): Error {
  return new Error(`not authorized: ${reason}`);
}

/** Primeira linha do erro, sem o caminho absoluto do checkout (o celular não precisa dele). */
function shortError(prefix: string, detail: string, root: string): Error {
  const scrubbed = detail.split(root).join('<checkout>');
  const line = scrubbed.split('\n').find((part) => part.trim())?.trim() ?? '';
  return new Error(`${prefix}: ${line.slice(0, MAX_ERROR_CHARS) || 'falhou'}`);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Checkout do pane que o aparelho pode ler, com a raiz real conferida. */
export function resolveRemotePaneWorkspace(
  paneRef: unknown,
  callerScope: ProjectExecutionScope,
): RemotePaneWorkspace {
  if (typeof paneRef !== 'string' || paneRef.length === 0 || paneRef.length > 128) {
    throw new Error('invalid paneId');
  }
  const pane = getPaneAuthzInfo(paneRef);
  if (!pane) throw new Error('pane not found');
  const decision = authorizePaneAccess({ role: 'user', scope: callerScope }, pane, 'read');
  if (!decision.allow) throw refuse(decision.reason ?? 'pane');
  // Navegador não tem checkout próprio; worker em worktree lê a SUA worktree.
  const scope = pane.kind === 'browser' ? undefined : (pane.executionScope ?? pane.scope);
  if (!scope?.rootRealPath) throw refuse('pane-has-no-checkout');
  const expected = path.resolve(scope.rootRealPath);
  let root: string;
  try {
    root = fs.realpathSync(expected);
  } catch {
    throw new Error('pane checkout is unavailable');
  }
  // A raiz registrada já é real: se o realpath mudou, o checkout foi trocado no disco.
  if (root !== expected || !fs.statSync(root).isDirectory()) {
    throw refuse('checkout-identity-changed');
  }
  return { paneId: pane.paneId, scope, root };
}

function isRestrictedSegment(segment: string): boolean {
  // `.GIT` é o mesmo diretório num disco sem distinção de caixa (APFS padrão).
  return segment.toLowerCase() === '.git' || SECRET_BASENAME_PATTERN.test(segment);
}

/** Caminho que o celular nunca lê (internos do Git, arquivos de segredo). */
export function isRestrictedRemotePath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment && isRestrictedSegment(segment));
}

/**
 * Normaliza e valida um caminho relativo ao checkout do pane. Devolve o
 * caminho POSIX normalizado ('' = raiz, só quando `allowRoot`).
 */
export function resolveRemoteWorkspacePath(
  root: string,
  input: unknown,
  options: { allowRoot: boolean },
): string {
  if (typeof input !== 'string' || input.length > MAX_PATH_CHARS) throw refuse('invalid-path');
  // Controle (inclui NUL) e barra invertida: nunca num caminho de repositório.
  // eslint-disable-next-line no-control-regex -- recusa caracteres de controle de propósito
  if (/[\u0000-\u001f\u007f\\]/.test(input)) throw refuse('invalid-path');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) throw refuse('absolute-path');
  const segments = input.split('/');
  if (segments.includes('..')) throw refuse('parent-traversal');
  const clean = segments.filter((segment) => segment !== '' && segment !== '.');
  if (clean.length === 0) {
    if (options.allowRoot) return '';
    throw refuse('invalid-path');
  }
  if (clean.some((segment) => segment.toLowerCase() === '.git')) throw refuse('git-internals');
  if (clean.some((segment) => SECRET_BASENAME_PATTERN.test(segment))) throw refuse('secret-file');
  // realpath: todo componente existente que for link precisa ficar na raiz real
  // (e fora de `.git`/segredo também depois de resolvido).
  let current = root;
  for (const segment of clean) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break; // apagado no working tree (diff de remoção): não há o que seguir.
    }
    if (!stat.isSymbolicLink()) continue;
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      throw refuse('path-escapes-checkout'); // link quebrado: destino não verificável
    }
    if (!isInside(root, real)) throw refuse('path-escapes-checkout');
    if (isRestrictedRemotePath(path.relative(root, real).split(path.sep).join('/'))) {
      throw refuse('secret-file');
    }
    current = real;
  }
  return clean.join('/');
}

export type RemoteGitChange = {
  readonly path: string;
  /** Letra do porcelain (M/A/D/R/C/U/?). */
  readonly status: string;
  readonly originalPath?: string;
  /** Diff recusado ao celular (`.git`/segredo): a linha aparece, o conteúdo não. */
  readonly restricted?: true;
};

export type RemoteGitStatus = {
  readonly paneId: string;
  readonly branch: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
  readonly clean: boolean;
  readonly truncated: boolean;
  readonly hasUnresolvedConflicts: boolean;
  readonly staged: readonly RemoteGitChange[];
  readonly unstaged: readonly RemoteGitChange[];
  readonly untracked: readonly RemoteGitChange[];
};

function remoteChange(change: GitFileChange): RemoteGitChange {
  const restricted =
    isRestrictedRemotePath(change.path) ||
    (change.originalPath !== undefined && isRestrictedRemotePath(change.originalPath));
  return {
    path: change.path,
    status: change.status,
    ...(change.originalPath ? { originalPath: change.originalPath } : {}),
    ...(restricted ? { restricted: true as const } : {}),
  };
}

/**
 * `git status` do checkout do pane pelo serviço do painel Git. Sem `remote`
 * (a URL pode carregar credencial) e sem a saída crua do porcelain.
 */
export async function remoteGitStatus(workspace: RemotePaneWorkspace): Promise<RemoteGitStatus> {
  const status = await gitScmStatus(workspace.root);
  if (!status.ok) throw shortError('git status failed', status.error, workspace.root);
  return {
    paneId: workspace.paneId,
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    hasUpstream: status.hasUpstream,
    clean: status.clean,
    truncated: status.truncated === true,
    hasUnresolvedConflicts: status.hasUnresolvedConflicts,
    staged: status.staged.map(remoteChange),
    unstaged: status.unstaged.map(remoteChange),
    untracked: status.untracked.map(remoteChange),
  };
}

type BoundedRead = {
  readonly content: string;
  readonly truncated: boolean;
  readonly byteLength: number;
  readonly binary: boolean;
};

function decodeUtf8Prefix(bytes: Buffer, cut: boolean): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  // Corte no meio de um caractere de vários bytes vira U+FFFD: tira só esse.
  return cut ? text.replace(/�$/u, '') : text;
}

function readBounded(workspace: RemotePaneWorkspace, relativePath: string): BoundedRead {
  // O leitor do desktop: abre sem seguir link, recusa hardlink e confere o
  // descritor contra a raiz do escopo do pane.
  const handle = openWorkspaceFileForRead(workspace.scope, relativePath);
  try {
    const size = handle.stat.size;
    const wanted = Math.min(size, REMOTE_FILE_READ_MAX_BYTES);
    const buffer = Buffer.alloc(wanted);
    let read = 0;
    while (read < wanted) {
      const count = fs.readSync(handle.fd, buffer, read, wanted - read, read);
      if (count === 0) break;
      read += count;
    }
    const bytes = buffer.subarray(0, read);
    if (looksBinary(bytes)) return { content: '', truncated: false, byteLength: size, binary: true };
    const truncated = size > read;
    return { content: decodeUtf8Prefix(bytes, truncated), truncated, byteLength: size, binary: false };
  } finally {
    handle.close();
  }
}

function limitChars(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

export type RemoteGitDiff =
  | {
      readonly path: string;
      readonly staged: boolean;
      readonly kind: 'patch';
      /** Patch unificado de `git diff --no-ext-diff` (HEAD ou índice). */
      readonly patch: string;
      readonly truncated: boolean;
    }
  | { readonly path: string; readonly staged: boolean; readonly kind: 'binary' }
  | ({ readonly path: string; readonly staged: boolean; readonly kind: 'untracked' } & BoundedRead);

/** Diff de UM arquivo do checkout do pane (o mesmo `gitFileDiff` do painel Git). */
export async function remoteGitDiff(
  workspace: RemotePaneWorkspace,
  rawPath: unknown,
  options: { staged: boolean; untracked: boolean },
): Promise<RemoteGitDiff> {
  const relativePath = resolveRemoteWorkspacePath(workspace.root, rawPath, { allowRoot: false });
  const staged = options.staged && !options.untracked;
  if (options.untracked) {
    // Arquivo novo não tem lado "antes": o conteúdo inteiro é a adição.
    return { path: relativePath, staged, kind: 'untracked', ...readBounded(workspace, relativePath) };
  }
  const diff = await gitFileDiff(workspace.root, relativePath, { staged });
  if (!diff.ok) throw shortError('git diff failed', diff.error, workspace.root);
  // Linha de cabeçalho do git (num patch de texto toda linha vem com prefixo).
  if (/^(?:Binary files .+ differ|GIT binary patch)$/m.test(diff.diff)) {
    return { path: relativePath, staged, kind: 'binary' };
  }
  const limited = limitChars(diff.diff, REMOTE_DIFF_MAX_CHARS);
  return {
    path: relativePath,
    staged,
    kind: 'patch',
    patch: limited.text,
    truncated: limited.truncated || diff.truncated === true,
  };
}

export type RemoteFileEntry = {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'dir';
};

/** Uma pasta do checkout do pane, pelo `listDir` do explorador do desktop. */
export async function remoteFilesList(
  workspace: RemotePaneWorkspace,
  rawPath: unknown,
): Promise<{ readonly path: string; readonly entries: readonly RemoteFileEntry[]; readonly truncated: boolean }> {
  const relativePath = resolveRemoteWorkspacePath(workspace.root, rawPath ?? '', { allowRoot: true });
  const listed = await listDir(workspace.scope, relativePath);
  if (!listed.ok) throw shortError('files list failed', listed.error ?? 'list failed', workspace.root);
  // Segredos nem aparecem (o explorador já esconde `.git`, links e node_modules).
  const visible = (listed.entries ?? []).filter((entry) => !isRestrictedSegment(entry.name));
  return {
    path: relativePath,
    entries: visible
      .slice(0, REMOTE_LIST_MAX_ENTRIES)
      .map((entry) => ({ name: entry.name, path: entry.relPath, kind: entry.kind })),
    truncated: visible.length > REMOTE_LIST_MAX_ENTRIES,
  };
}

/** Um arquivo do checkout do pane, cortado em `REMOTE_FILE_READ_MAX_BYTES`. */
export function remoteFilesRead(
  workspace: RemotePaneWorkspace,
  rawPath: unknown,
): { readonly path: string } & BoundedRead {
  const relativePath = resolveRemoteWorkspacePath(workspace.root, rawPath, { allowRoot: false });
  return { path: relativePath, ...readBounded(workspace, relativePath) };
}
