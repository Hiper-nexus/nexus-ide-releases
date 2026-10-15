import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  MissionAttachmentSnapshot,
} from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';

const IS_WINDOWS = process.platform === 'win32';

/**
 * #21: o caminho dos BYTES (decode, gravação, fsync, cópia) não bloqueia o
 * Main. `realpath` em JS (promisify), o mesmo algoritmo do `realpathSync`: o
 * nativo corrige a caixa no APFS e mudaria as comparações de raiz.
 */
const fsp = fs.promises;
const realpath = promisify(fs.realpath);
const readFd = promisify(fs.read);

/**
 * No Windows não há modo POSIX: diretórios reportam sempre 0o666 e o chmod só
 * controla o atributo read-only. A privacidade ali vem da ACL do perfil do
 * usuário (já privada por padrão) e o lacre do bit read-only — por isso os
 * checks de modo exato (0o700/0o400) só valem fora do win32. dev/ino/nlink do
 * NTFS são reais, então as provas de identidade de arquivo se mantêm.
 */
function sealedFileModeIsImmutable(stat: { mode: number | bigint }): boolean {
  const mode = BigInt(stat.mode) & 0o777n;
  return IS_WINDOWS ? (mode & 0o222n) === 0n : mode === 0o400n;
}

function fsyncDirectoryIfPosix(directoryFd: number): void {
  if (IS_WINDOWS) return;
  fs.fsyncSync(directoryFd);
}

export const DROPPED_ATTACHMENT_MAX_COUNT = 6;
export const DROPPED_ATTACHMENT_MAX_PATH_CHARS = 4_096;
export const DROPPED_ATTACHMENT_MAX_BYTES = 14 * 1024 * 1024;
export const DROPPED_ATTACHMENTS_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const DROPPED_ATTACHMENT_MAX_BASE64_CHARS =
  Math.ceil(DROPPED_ATTACHMENT_MAX_BYTES / 3) * 4;

interface FileOwnershipSecurityOptions {
  readonly expectedUid?: number | null;
}

interface DroppedFileSecurityOptions extends FileOwnershipSecurityOptions {
  readonly homeDir?: string;
}

export interface WorkspaceRootAuthority {
  readonly rootRealPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface GovernedAttachmentSecurityOptions
  extends FileOwnershipSecurityOptions {
  readonly workspaceRootAuthority: WorkspaceRootAuthority;
  readonly rootLabel?: string;
}

export interface SealedMissionAttachmentSecurityOptions
  extends GovernedAttachmentSecurityOptions,
    DroppedFileSecurityOptions {
  readonly checkoutId: string;
  readonly sealId?: () => string;
}

export interface SealedMissionAttachmentLifecycleOptions
  extends DroppedFileSecurityOptions {
  readonly checkoutId: string;
}

export interface SaveDroppedFileOptions extends DroppedFileSecurityOptions {
  readonly token?: () => string;
}

export type SaveDroppedFileResult =
  | {
      readonly ok: true;
      /** Relativo à raiz do projeto (ou absoluto, nos imports que já o são). */
      readonly path: string;
      /**
       * Onde o arquivo ESTÁ de fato (realpath, verificado depois da gravação).
       * O renderer o digita no pane: recompor `path` contra a pasta do pane
       * apontava para a worktree, onde o anexo não existe (F-760).
       */
      readonly absolutePath?: string;
    }
  | { readonly ok: false; readonly error: string };

export interface DroppedAttachmentSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

function expectedUid(options: FileOwnershipSecurityOptions): number | null {
  if (options.expectedUid !== undefined) return options.expectedUid;
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function canonicalHome(options: DroppedFileSecurityOptions): string {
  return fs.realpathSync(options.homeDir ?? os.homedir());
}

function assertOwned(
  stat: fs.Stats,
  uid: number | null,
  label: string,
): void {
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`${label} owner uid does not match the Nexus process`);
  }
}

function assertSingleLink(stat: fs.Stats, label: string): void {
  if (stat.nlink !== 1) {
    throw new Error(`${label} must have exactly one filesystem link`);
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDroppedDirectory(
  options: DroppedFileSecurityOptions,
  create: boolean,
): string {
  const home = canonicalHome(options);
  const uid = expectedUid(options);
  const nexusDir = path.join(home, '.nexus');
  const root = path.join(nexusDir, 'dropped');
  if (create && !fs.existsSync(nexusDir)) {
    fs.mkdirSync(nexusDir, { mode: 0o700 });
  }
  const nexusStat = fs.lstatSync(nexusDir);
  if (nexusStat.isSymbolicLink() || !nexusStat.isDirectory()) {
    throw new Error('~/.nexus must be a real directory');
  }
  assertOwned(nexusStat, uid, '~/.nexus');
  if (fs.realpathSync(nexusDir) !== path.resolve(nexusDir)) {
    throw new Error('~/.nexus cannot traverse a symlink');
  }
  if (create && !fs.existsSync(root)) {
    fs.mkdirSync(root, { mode: 0o700 });
  }
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('~/.nexus/dropped must be a real directory');
  }
  assertOwned(rootStat, uid, '~/.nexus/dropped');
  const realRoot = fs.realpathSync(root);
  if (realRoot !== path.resolve(root)) {
    throw new Error('~/.nexus/dropped cannot traverse a symlink');
  }
  if (create) fs.chmodSync(root, 0o700);
  return realRoot;
}
export function workspaceRootAuthorityFromScope(
  scope: Pick<
    ProjectExecutionScope,
    'rootRealPath' | 'workspaceRootDevice' | 'workspaceRootInode'
  >,
): WorkspaceRootAuthority {
  if (!scope.workspaceRootDevice || !scope.workspaceRootInode) {
    throw new Error(
      'workspace root filesystem identity is required for governed attachments',
    );
  }
  return Object.freeze({
    rootRealPath: scope.rootRealPath,
    device: scope.workspaceRootDevice,
    inode: scope.workspaceRootInode,
  });
}

function requireWorkspaceRootAuthority(
  authority: WorkspaceRootAuthority,
): string {
  if (!Object.isFrozen(authority)) {
    throw new Error('workspaceRootAuthority must be frozen');
  }
  if (
    !path.isAbsolute(authority.rootRealPath) ||
    authority.rootRealPath.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
    /[\u0000-\u001f\u007f]/.test(authority.rootRealPath) ||
    !/^[0-9]+$/.test(authority.device) ||
    !/^[0-9]+$/.test(authority.inode)
  ) {
    throw new Error('workspaceRootAuthority is invalid');
  }
  const lexicalRoot = path.resolve(authority.rootRealPath);
  const stat = fs.lstatSync(lexicalRoot, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('authorized workspace must remain a real directory');
  }
  if (
    fs.realpathSync(lexicalRoot) !== lexicalRoot ||
    stat.dev.toString() !== authority.device ||
    stat.ino.toString() !== authority.inode
  ) {
    throw new Error('authorized workspace filesystem identity changed');
  }
  return lexicalRoot;
}

function requireGovernedAttachmentDirectory(
  options: GovernedAttachmentSecurityOptions,
): string {
  const label = options.rootLabel ?? 'governed attachment root';
  const workspaceRoot = requireWorkspaceRootAuthority(
    options.workspaceRootAuthority,
  );
  const nexusDir = path.join(workspaceRoot, '.nexus');
  const resolvedRoot = path.join(nexusDir, 'attachments');
  const uid = expectedUid(options);
  const nexusStat = fs.lstatSync(nexusDir);
  if (nexusStat.isSymbolicLink() || !nexusStat.isDirectory()) {
    throw new Error(`${label} parent .nexus must be a real directory`);
  }
  assertOwned(nexusStat, uid, `${label} parent .nexus`);

  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  assertOwned(rootStat, uid, label);

  const realNexusDir = fs.realpathSync(nexusDir);
  const realRoot = fs.realpathSync(resolvedRoot);
  if (
    realNexusDir !== path.join(workspaceRoot, '.nexus') ||
    realRoot !== path.join(realNexusDir, 'attachments')
  ) {
    throw new Error(`${label} cannot traverse a symlink`);
  }
  const canonicalNexusStat = fs.lstatSync(realNexusDir);
  const canonicalRootStat = fs.lstatSync(realRoot);
  if (
    canonicalNexusStat.isSymbolicLink() ||
    !canonicalNexusStat.isDirectory() ||
    canonicalRootStat.isSymbolicLink() ||
    !canonicalRootStat.isDirectory() ||
    !sameFileIdentity(nexusStat, canonicalNexusStat) ||
    !sameFileIdentity(rootStat, canonicalRootStat)
  ) {
    throw new Error(`${label} changed during validation`);
  }
  assertOwned(canonicalNexusStat, uid, `${label} parent .nexus`);
  assertOwned(canonicalRootStat, uid, label);
  requireWorkspaceRootAuthority(options.workspaceRootAuthority);
  return realRoot;
}


function safeToken(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'drop';
}

export function droppedFileName(name: string, token: string): string {
  const safeName =
    path
      .basename(name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(-80) || 'pasted';
  return `${safeToken(token)}-${safeName}`;
}

/** 1 Mi caracteres (múltiplo de 4): decode + prova de cada fatia leva ~1 ms. */
const BASE64_SLICE_CHARS = 1024 * 1024;

/**
 * Decodifica o base64 do renderer em fatias, cedendo o loop entre elas. A
 * prova continua a mesma: re-encodar dá EXATAMENTE a entrada (só alfabeto
 * válido, padding só no fim, bits finais zerados). A regex de antes fazia
 * backtracking por grupo e estourava a pilha acima de ~3 MiB, recusando
 * qualquer drop grande.
 */
async function decodeBase64(base64: string): Promise<Buffer> {
  if (
    base64.length > DROPPED_ATTACHMENT_MAX_BASE64_CHARS ||
    base64.length % 4 !== 0
  ) {
    throw new Error('invalid or oversized dropped-file payload');
  }
  const parts: Buffer[] = [];
  let size = 0;
  for (let start = 0; start < base64.length; start += BASE64_SLICE_CHARS) {
    const slice = base64.slice(start, start + BASE64_SLICE_CHARS);
    const last = start + BASE64_SLICE_CHARS >= base64.length;
    const part = Buffer.from(slice, 'base64');
    if ((!last && slice.includes('=')) || part.toString('base64') !== slice) {
      throw new Error('invalid or oversized dropped-file payload');
    }
    size += part.length;
    if (size > DROPPED_ATTACHMENT_MAX_BYTES) {
      throw new Error('dropped file exceeds the 14 MiB item limit');
    }
    parts.push(part);
    if (!last) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return Buffer.concat(parts, size);
}

interface ExclusiveFileLabels {
  /** Prefixo das mensagens de staging ("dropped-file", "mission context"). */
  readonly stage: string;
  /** Nome do arquivo nas provas de dono/link ("dropped file"). */
  readonly file: string;
}

const DROPPED_LABELS: ExclusiveFileLabels = { stage: 'dropped-file', file: 'dropped file' };
const MISSION_CONTEXT_LABELS: ExclusiveFileLabels = {
  stage: 'mission context',
  file: 'mission context file',
};

/**
 * Cria `file` em `root` com O_EXCL|O_NOFOLLOW, grava por `writeInto`, fsync e
 * prova que o caminho canônico ainda é o mesmo inode privado, do dono e de
 * link único. Qualquer falha desfaz só o arquivo que ela mesma criou.
 */
async function writeExclusivePrivateFile(
  root: string,
  file: string,
  uid: number | null,
  expectedSize: number,
  writeInto: (handle: FileHandle) => Promise<void>,
  labels: ExclusiveFileLabels,
): Promise<string> {
  let handle: FileHandle | null = null;
  let createdIdentity: fs.Stats | null = null;
  try {
    const noFollow =
      'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    handle = await fsp.open(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    const opened = await handle.stat();
    createdIdentity = opened;
    if (!opened.isFile()) {
      throw new Error(`${labels.stage} target is not a regular file`);
    }
    assertOwned(opened, uid, labels.file);
    assertSingleLink(opened, labels.file);
    await writeInto(handle);
    await handle.chmod(0o600);
    await handle.sync();
    const written = await handle.stat();
    if (
      !written.isFile() ||
      written.size !== expectedSize ||
      !sameFileIdentity(opened, written)
    ) {
      throw new Error(`${labels.stage} write was not durable`);
    }
    assertSingleLink(written, labels.file);
    const canonical = await realpath(file);
    const current = await fsp.lstat(file);
    const canonicalStat = await fsp.lstat(canonical);
    if (
      !isInside(root, canonical) ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !canonicalStat.isFile() ||
      !sameFileIdentity(written, current) ||
      !sameFileIdentity(written, canonicalStat)
    ) {
      throw new Error(`${labels.stage} path changed during staging`);
    }
    assertOwned(current, uid, labels.file);
    assertSingleLink(current, labels.file);
    const closing = handle;
    handle = null;
    await closing.close();
    return canonical;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (createdIdentity) {
      try {
        const current = await fsp.lstat(file);
        if (
          !current.isSymbolicLink() &&
          sameFileIdentity(createdIdentity, current)
        ) {
          await fsp.unlink(file);
        }
      } catch {
        // The exclusively-created file was already removed.
      }
    }
    throw error;
  }
}

/**
 * Stages one renderer-provided blob without following links or replacing an
 * existing path. The returned path is already canonical and private.
 */
export async function saveDroppedFile(
  name: string,
  base64: string,
  options: SaveDroppedFileOptions = {},
): Promise<SaveDroppedFileResult> {
  try {
    const decoded = await decodeBase64(base64);
    const root = requireDroppedDirectory(options, true);
    const token =
      options.token?.() ??
      `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
    const canonical = await writeExclusivePrivateFile(
      root,
      path.join(root, droppedFileName(name, token)),
      expectedUid(options),
      decoded.length,
      (handle) => handle.writeFile(decoded),
      DROPPED_LABELS,
    );
    return { ok: true, path: canonical };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'save failed',
    };
  }
}

export const MISSION_CONTEXT_ATTACHMENT_SEGMENTS = [
  '.nexus',
  'attachments',
  'mission-context',
] as const;

export const MISSION_CONTEXT_ATTACHMENT_PREFIX = `${MISSION_CONTEXT_ATTACHMENT_SEGMENTS.join('/')}/`;

function isInsideOrSame(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function requireRealWorkspaceRoot(
  workspaceRoot: string,
  uid: number | null,
): string {
  if (
    !path.isAbsolute(workspaceRoot) ||
    workspaceRoot.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
    /[\u0000-\u001f\u007f]/.test(workspaceRoot)
  ) {
    throw new Error('workspace root is invalid');
  }
  const lexical = path.resolve(workspaceRoot);
  const stat = fs.lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('workspace root must be a real directory');
  }
  assertOwned(stat, uid, 'workspace root');
  const real = fs.realpathSync(lexical);
  if (real !== lexical) {
    throw new Error('workspace root cannot traverse a symlink');
  }
  return real;
}

function ensurePrivateChildDirectory(
  parentReal: string,
  childName: string,
  uid: number | null,
  workspaceRoot: string,
): string {
  const next = path.join(parentReal, childName);
  if (!fs.existsSync(next)) {
    fs.mkdirSync(next, { mode: 0o700 });
  }
  const stat = fs.lstatSync(next);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('mission context directory is invalid');
  }
  assertOwned(stat, uid, 'mission context directory');
  const real = fs.realpathSync(next);
  if (real !== path.resolve(next) || !isInsideOrSame(workspaceRoot, real)) {
    throw new Error('mission context directory cannot traverse a symlink');
  }
  fs.chmodSync(real, 0o700);
  return real;
}

function requireMissionContextDirectory(
  workspaceRoot: string,
  uid: number | null,
): string {
  let current = requireRealWorkspaceRoot(workspaceRoot, uid);
  for (const segment of MISSION_CONTEXT_ATTACHMENT_SEGMENTS) {
    current = ensurePrivateChildDirectory(current, segment, uid, workspaceRoot);
  }
  return current;
}

/**
 * Copies one renderer-provided blob into the project so mission agents can
 * read it. Returns a root-relative context path, never a host home path.
 */
export async function importWorkspaceMissionAttachment(
  workspaceRoot: string,
  name: string,
  base64: string,
  options: SaveDroppedFileOptions = {},
): Promise<SaveDroppedFileResult> {
  let decoded: Buffer;
  try {
    decoded = await decodeBase64(base64);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'import failed',
    };
  }
  return importWorkspaceMissionAttachmentBytes(
    workspaceRoot,
    name,
    decoded,
    options,
  );
}

export const DROPPED_LOCAL_FILE_MAX_BYTES = 256 * 1024 * 1024;

const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * Núcleo endurecido compartilhado pelos imports de mission-context: criação
 * O_EXCL|O_NOFOLLOW, fstat/owner/single-link, fsync, verificação de
 * durabilidade/identidade e o espelho best-effort em
 * ~/.nexus/attachments/mission-context/. `writeInto` é o único ponto que
 * varia (blob único vs. stream de um fd local); se ele lançar, o arquivo
 * criado exclusivamente é desfeito pelo cleanup comum.
 */
async function stageMissionContextFile(
  workspaceRoot: string,
  name: string,
  options: SaveDroppedFileOptions,
  payload: {
    readonly expectedSize: number;
    readonly writeInto: (handle: FileHandle) => Promise<void>;
  },
): Promise<SaveDroppedFileResult> {
  try {
    const uid = expectedUid(options);
    const root = requireMissionContextDirectory(workspaceRoot, uid);
    const token =
      options.token?.() ??
      `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
    const storedName = droppedFileName(name, token);
    const canonical = await writeExclusivePrivateFile(
      root,
      path.join(root, storedName),
      uid,
      payload.expectedSize,
      payload.writeInto,
      MISSION_CONTEXT_LABELS,
    );

    // Espelho de conveniência em ~/.nexus/attachments/mission-context/:
    // Agentes de linha de comando (como Claude Code, Kimi, etc.) frequentemente deduzem
    // que caminhos iniciados por `.nexus/...` vivem em `~/.nexus/attachments/`.
    // Espelhar o arquivo garante que ferramentas e buscas na home encontrem o anexo.
    // Conveniência tem teto: duplicar um vídeo de 200 MB na home não é
    // conveniência — acima de 14 MiB a cópia do workspace basta (F-582).
    try {
      if (payload.expectedSize <= DROPPED_ATTACHMENT_MAX_BYTES) {
        const home = canonicalHome(options);
        const userNexus = path.join(home, '.nexus');
        if (fs.existsSync(userNexus)) {
          const userAttachments = path.join(userNexus, 'attachments');
          if (!fs.existsSync(userAttachments)) {
            fs.mkdirSync(userAttachments, { mode: 0o700 });
          }
          const userMissionContext = path.join(userAttachments, 'mission-context');
          if (!fs.existsSync(userMissionContext)) {
            fs.mkdirSync(userMissionContext, { mode: 0o700 });
          }
          const mirrorFile = path.join(userMissionContext, storedName);
          await fsp.copyFile(canonical, mirrorFile, fs.constants.COPYFILE_EXCL);
        }
      }
    } catch {
      // Espelho é puramente auxiliar; falha silenciosa não interrompe o salvamento primário.
    }

    return {
      ok: true,
      path: `${MISSION_CONTEXT_ATTACHMENT_PREFIX}${storedName}`,
      absolutePath: canonical,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'import failed',
    };
  }
}

/**
 * Same staging for bytes that never crossed the IPC as base64 — a `file://`
 * read or an http(s) download done in main. Enforces the same 14 MiB cap.
 */
export async function importWorkspaceMissionAttachmentBytes(
  workspaceRoot: string,
  name: string,
  decoded: Buffer,
  options: SaveDroppedFileOptions = {},
): Promise<SaveDroppedFileResult> {
  if (decoded.length > DROPPED_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: 'dropped file exceeds the 14 MiB item limit',
    };
  }
  return stageMissionContextFile(workspaceRoot, name, options, {
    expectedSize: decoded.length,
    writeInto: (handle) => handle.writeFile(decoded),
  });
}

/**
 * Variante stream do staging acima: copia um arquivo local já aberto
 * (`sourceFd`, validado pelo chamador com O_NOFOLLOW + fstat) em blocos de
 * 1 MiB — nunca carrega o arquivo inteiro na memória. Aborta se o total
 * ultrapassar `maxBytes` (padrão 256 MiB, F-582) ou o tamanho final não bater
 * com `expectedSize` (o arquivo mudou durante a cópia).
 */
export async function importWorkspaceMissionAttachmentFromFile(
  workspaceRoot: string,
  name: string,
  sourceFd: number,
  expectedSize: number,
  options: SaveDroppedFileOptions & { maxBytes?: number } = {},
): Promise<SaveDroppedFileResult> {
  const maxBytes = options.maxBytes ?? DROPPED_LOCAL_FILE_MAX_BYTES;
  return stageMissionContextFile(workspaceRoot, name, options, {
    expectedSize,
    writeInto: async (handle) => {
      const chunk = Buffer.allocUnsafe(
        Math.min(STREAM_CHUNK_BYTES, Math.max(1, expectedSize)),
      );
      let total = 0;
      for (;;) {
        const { bytesRead: read } = await readFd(
          sourceFd,
          chunk,
          0,
          chunk.length,
          null,
        );
        if (read === 0) break;
        total += read;
        if (total > maxBytes) {
          throw new Error('local file exceeds the 256 MiB item limit');
        }
        await handle.write(chunk, 0, read);
      }
      if (total !== expectedSize) {
        throw new Error('local file changed during the staged copy');
      }
    },
  });
}

function assertAttachmentCount(paths: readonly unknown[]): void {
  if (paths.length > DROPPED_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `mission attachments exceed the ${DROPPED_ATTACHMENT_MAX_COUNT}-file limit`,
    );
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function inspectGovernedAttachmentPaths(
  paths: readonly string[] | undefined,
  root: string,
  uid: number | null,
  rootLabel: string,
): DroppedAttachmentSnapshot[] | undefined {
  if (paths === undefined) return undefined;
  assertAttachmentCount(paths);
  if (paths.length === 0) return [];
  const validated: DroppedAttachmentSnapshot[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const raw of paths) {
    if (
      raw.length === 0 ||
      raw.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
      !path.isAbsolute(raw) ||
      /[\u0000-\u001f\u007f]/.test(raw)
    ) {
      throw new Error('mission attachment path is invalid');
    }
    let fd: number | null = null;
    try {
      const before = fs.lstatSync(raw);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(
          'mission attachment must be a regular non-symlink file',
        );
      }
      assertOwned(before, uid, 'mission attachment');
      assertSingleLink(before, 'mission attachment');

      const noFollow =
        'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
      fd = fs.openSync(raw, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameFileIdentity(before, opened)) {
        throw new Error('mission attachment changed during validation');
      }
      assertOwned(opened, uid, 'mission attachment');
      assertSingleLink(opened, 'mission attachment');

      const canonical = fs.realpathSync(raw);
      if (!isInside(root, canonical)) {
        throw new Error(`mission attachment is outside ${rootLabel}`);
      }
      const current = fs.lstatSync(raw);
      const canonicalStat = fs.lstatSync(canonical);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        !canonicalStat.isFile() ||
        !sameFileIdentity(opened, current) ||
        !sameFileIdentity(opened, canonicalStat)
      ) {
        throw new Error('mission attachment changed during validation');
      }
      assertOwned(current, uid, 'mission attachment');
      assertSingleLink(current, 'mission attachment');
      if (opened.size > DROPPED_ATTACHMENT_MAX_BYTES) {
        throw new Error('mission attachment exceeds the 14 MiB item limit');
      }
      if (seen.has(canonical)) {
        throw new Error('mission attachment paths must be unique');
      }
      seen.add(canonical);
      totalBytes += opened.size;
      if (totalBytes > DROPPED_ATTACHMENTS_MAX_TOTAL_BYTES) {
        throw new Error('mission attachments exceed the 40 MiB total limit');
      }
      const contents = fs.readFileSync(fd);
      const afterRead = fs.fstatSync(fd);
      const afterPathRead = fs.lstatSync(canonical);
      if (
        !sameFileIdentity(opened, afterRead) ||
        !sameFileIdentity(opened, afterPathRead) ||
        opened.size !== afterRead.size ||
        opened.mtimeMs !== afterRead.mtimeMs ||
        opened.ctimeMs !== afterRead.ctimeMs ||
        contents.length !== opened.size
      ) {
        throw new Error('mission attachment changed while hashing');
      }
      validated.push(
        Object.freeze({
          path: canonical,
          sha256: createHash('sha256').update(contents).digest('hex'),
          size: opened.size,
        }),
      );
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return validated;
}

function inspectDroppedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: DroppedFileSecurityOptions = {},
): DroppedAttachmentSnapshot[] | undefined {
  if (paths === undefined) return undefined;
  assertAttachmentCount(paths);
  return inspectGovernedAttachmentPaths(
    paths,
    requireDroppedDirectory(options, false),
    expectedUid(options),
    '~/.nexus/dropped',
  );
}

export function snapshotGovernedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: GovernedAttachmentSecurityOptions,
): DroppedAttachmentSnapshot[] | undefined {
  if (paths === undefined) return undefined;
  assertAttachmentCount(paths);
  const root = requireGovernedAttachmentDirectory(options);
  const snapshots = inspectGovernedAttachmentPaths(
    paths,
    root,
    expectedUid(options),
    options.rootLabel ?? 'governed attachment root',
  )?.map((entry) => ({ ...entry }));
  requireWorkspaceRootAuthority(options.workspaceRootAuthority);
  return snapshots;
}

export function snapshotDroppedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: DroppedFileSecurityOptions = {},
): DroppedAttachmentSnapshot[] | undefined {
  return inspectDroppedAttachmentPaths(paths, options)?.map((entry) => ({ ...entry }));
}

export function validateDroppedAttachmentPaths(
  paths: readonly string[] | undefined,
  options: DroppedFileSecurityOptions = {},
): string[] | undefined {
  return inspectDroppedAttachmentPaths(paths, options)?.map((entry) => entry.path);
}

const SEALED_ATTACHMENT_DIRECTORY_MODE = 0o700;
const SEALED_ATTACHMENT_FILE_MODE = 0o400;
const DEFAULT_ORPHAN_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;

function assertBigIntOwned(
  stat: fs.BigIntStats,
  uid: number | null,
  label: string,
): void {
  if (uid !== null && stat.uid !== BigInt(uid)) {
    throw new Error(`${label} owner uid does not match the Nexus process`);
  }
}

function sameBigIntFileIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requirePrivateRealDirectory(
  directory: string,
  label: string,
  uid: number | null,
  create: boolean,
): string {
  if (create && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, { mode: SEALED_ATTACHMENT_DIRECTORY_MODE });
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  assertOwned(stat, uid, label);
  const canonical = fs.realpathSync(directory);
  if (canonical !== path.resolve(directory)) {
    throw new Error(`${label} cannot traverse a symlink`);
  }
  if (!IS_WINDOWS) {
    if (create) fs.chmodSync(canonical, SEALED_ATTACHMENT_DIRECTORY_MODE);
    if ((fs.lstatSync(canonical).mode & 0o777) !== SEALED_ATTACHMENT_DIRECTORY_MODE) {
      throw new Error(`${label} must be private`);
    }
  }
  return canonical;
}

function validCheckoutId(checkoutId: string): boolean {
  return (
    checkoutId !== '.' &&
    checkoutId !== '..' &&
    /^[a-zA-Z0-9._-]{1,128}$/.test(checkoutId)
  );
}

function sealedAttachmentDirectory(
  options: SealedMissionAttachmentLifecycleOptions,
  create: boolean,
): string {
  if (!validCheckoutId(options.checkoutId)) {
    throw new Error('sealed attachment checkout identity is invalid');
  }
  const home = canonicalHome(options);
  const uid = expectedUid(options);
  const nexusDir = path.join(home, '.nexus');
  const missionRoot = path.join(nexusDir, 'mission-attachments');
  const checkoutRoot = path.join(missionRoot, options.checkoutId);
  if (!create && !fs.existsSync(checkoutRoot)) return checkoutRoot;
  requirePrivateRealDirectory(nexusDir, '~/.nexus', uid, create);
  requirePrivateRealDirectory(
    missionRoot,
    '~/.nexus/mission-attachments',
    uid,
    create,
  );
  return requirePrivateRealDirectory(
    checkoutRoot,
    `sealed attachment checkout ${options.checkoutId}`,
    uid,
    create,
  );
}

function assertSealedSnapshotMetadata(
  snapshot: MissionAttachmentSnapshot,
): asserts snapshot is MissionAttachmentSnapshot & {
  readonly sourcePath: string;
  readonly sealId: string;
  readonly device: string;
  readonly inode: string;
} {
  if (
    !snapshot.sourcePath ||
    !path.isAbsolute(snapshot.sourcePath) ||
    snapshot.sourcePath.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
    /[\u0000-\u001f\u007f]/.test(snapshot.sourcePath) ||
    !snapshot.sealId ||
    !/^[a-f0-9]{64}$/.test(snapshot.sha256) ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size < 0 ||
    snapshot.size > DROPPED_ATTACHMENT_MAX_BYTES ||
    !/^[a-f0-9]{32,128}$/.test(snapshot.sealId) ||
    !snapshot.device ||
    !/^[0-9]+$/.test(snapshot.device) ||
    !snapshot.inode ||
    !/^[0-9]+$/.test(snapshot.inode) ||
    ((snapshot.ctimeNs !== undefined || snapshot.mtimeNs !== undefined) &&
      (snapshot.ctimeNs === undefined ||
        snapshot.mtimeNs === undefined ||
        !/^[0-9]+$/.test(snapshot.ctimeNs) ||
        !/^[0-9]+$/.test(snapshot.mtimeNs)))
  ) {
    throw new Error('sealed attachment metadata is incomplete or invalid');
  }
}

function assertSealedPath(
  snapshot: MissionAttachmentSnapshot & { readonly sealId: string },
  root: string,
): void {
  if (
    !path.isAbsolute(snapshot.path) ||
    snapshot.path.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
    /[\u0000-\u001f\u007f]/.test(snapshot.path) ||
    path.dirname(path.resolve(snapshot.path)) !== root
  ) {
    throw new Error('sealed attachment path is outside its checkout namespace');
  }
  const basename = path.basename(snapshot.path);
  if (
    basename !== snapshot.sealId &&
    !basename.startsWith(`${snapshot.sealId}.`)
  ) {
    throw new Error('sealed attachment path does not match its seal identity');
  }
}

function safeSealedExtension(sourcePath: string): string {
  const extension = path.extname(sourcePath);
  return /^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : '';
}

function readExactFd(fd: number, size: number): Buffer {
  const contents = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, contents, offset, size - offset, offset);
    if (read === 0) throw new Error('sealed attachment read ended early');
    offset += read;
  }
  return contents;
}

function writeSealedAttachment(
  sourcePath: string,
  contents: Buffer,
  options: SealedMissionAttachmentSecurityOptions,
): MissionAttachmentSnapshot {
  const root = sealedAttachmentDirectory(options, true);
  const uid = expectedUid(options);
  const workspaceRoot = requireWorkspaceRootAuthority(
    options.workspaceRootAuthority,
  );
  if (root === workspaceRoot || isInside(workspaceRoot, root)) {
    throw new Error('sealed attachment storage must remain outside the checkout');
  }
  const rawSealId =
    options.sealId?.() ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32,128}$/.test(rawSealId)) {
    throw new Error('sealed attachment id is invalid');
  }
  const sealId = rawSealId;
  const sealedPath = path.join(
    root,
    `${sealId}${safeSealedExtension(sourcePath)}`,
  );
  const noFollow =
    'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const directoryFlag =
    'O_DIRECTORY' in fs.constants ? fs.constants.O_DIRECTORY : 0;
  let directoryFd: number | null = null;
  let fileFd: number | null = null;
  let createdIdentity: fs.BigIntStats | null = null;
  try {
    directoryFd = fs.openSync(
      root,
      fs.constants.O_RDONLY | noFollow | directoryFlag,
    );
    const openedDirectory = fs.fstatSync(directoryFd, { bigint: true });
    const currentDirectory = fs.lstatSync(root, { bigint: true });
    if (
      !openedDirectory.isDirectory() ||
      currentDirectory.isSymbolicLink() ||
      !sameBigIntFileIdentity(openedDirectory, currentDirectory)
    ) {
      throw new Error('sealed attachment directory changed before creation');
    }

    fileFd = fs.openSync(
      sealedPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      SEALED_ATTACHMENT_FILE_MODE,
    );
    const opened = fs.fstatSync(fileFd, { bigint: true });
    createdIdentity = opened;
    if (!opened.isFile()) {
      throw new Error('sealed attachment target is not a regular file');
    }
    assertBigIntOwned(opened, uid, 'sealed attachment');
    if (opened.nlink !== 1n) {
      throw new Error('sealed attachment must have exactly one filesystem link');
    }

    fs.writeFileSync(fileFd, contents);
    fs.fchmodSync(fileFd, SEALED_ATTACHMENT_FILE_MODE);
    fs.fsyncSync(fileFd);
    const sealedBytes = readExactFd(fileFd, contents.length);
    const written = fs.fstatSync(fileFd, { bigint: true });
    if (
      !written.isFile() ||
      !sameBigIntFileIdentity(opened, written) ||
      written.size !== BigInt(contents.length) ||
      written.nlink !== 1n ||
      !sealedFileModeIsImmutable(written) ||
      !sealedBytes.equals(contents)
    ) {
      throw new Error('sealed attachment bytes were not durably published');
    }
    assertBigIntOwned(written, uid, 'sealed attachment');
    fsyncDirectoryIfPosix(directoryFd);

    const canonical = fs.realpathSync(sealedPath);
    const current = fs.lstatSync(sealedPath, { bigint: true });
    if (
      canonical !== sealedPath ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameBigIntFileIdentity(written, current)
    ) {
      throw new Error('sealed attachment path changed during publication');
    }
    const currentDirectoryAfter = fs.lstatSync(root, { bigint: true });
    if (
      !sameBigIntFileIdentity(openedDirectory, currentDirectoryAfter) ||
      fs.realpathSync(root) !== root
    ) {
      throw new Error('sealed attachment directory changed during publication');
    }
    return Object.freeze({
      path: canonical,
      sourcePath,
      sealId,
      sha256: createHash('sha256').update(sealedBytes).digest('hex'),
      size: sealedBytes.length,
      device: written.dev.toString(),
      inode: written.ino.toString(),
      ctimeNs: written.ctimeNs.toString(),
      mtimeNs: written.mtimeNs.toString(),
    });
  } catch (error) {
    if (createdIdentity) {
      try {
        const current = fs.lstatSync(sealedPath, { bigint: true });
        if (
          !current.isSymbolicLink() &&
          sameBigIntFileIdentity(createdIdentity, current)
        ) {
          fs.unlinkSync(sealedPath);
        }
      } catch {
        // The exclusively-created artifact is already absent.
      }
    }
    throw error;
  } finally {
    if (fileFd !== null) fs.closeSync(fileFd);
    if (directoryFd !== null) fs.closeSync(directoryFd);
  }
}

export function sealGovernedAttachmentPath(
  rawPath: string,
  options: SealedMissionAttachmentSecurityOptions,
): MissionAttachmentSnapshot {
  const root = requireGovernedAttachmentDirectory(options);
  const uid = expectedUid(options);
  if (
    rawPath.length === 0 ||
    rawPath.length > DROPPED_ATTACHMENT_MAX_PATH_CHARS ||
    !path.isAbsolute(rawPath) ||
    /[\u0000-\u001f\u007f]/.test(rawPath)
  ) {
    throw new Error('mission attachment path is invalid');
  }
  let fd: number | null = null;
  try {
    const before = fs.lstatSync(rawPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('mission attachment must be a regular non-symlink file');
    }
    assertOwned(before, uid, 'mission attachment');
    assertSingleLink(before, 'mission attachment');
    const noFollow =
      'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(rawPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error('mission attachment changed during validation');
    }
    assertOwned(opened, uid, 'mission attachment');
    assertSingleLink(opened, 'mission attachment');
    if (opened.size > DROPPED_ATTACHMENT_MAX_BYTES) {
      throw new Error('mission attachment exceeds the 14 MiB item limit');
    }

    const canonical = fs.realpathSync(rawPath);
    if (!isInside(root, canonical)) {
      throw new Error('mission attachment is outside governed attachment root');
    }
    const current = fs.lstatSync(rawPath);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameFileIdentity(opened, current)
    ) {
      throw new Error('mission attachment changed during validation');
    }
    const contents = fs.readFileSync(fd);
    const afterRead = fs.fstatSync(fd);
    const afterPathRead = fs.lstatSync(canonical);
    if (
      !sameFileIdentity(opened, afterRead) ||
      !sameFileIdentity(opened, afterPathRead) ||
      opened.size !== afterRead.size ||
      opened.mtimeMs !== afterRead.mtimeMs ||
      opened.ctimeMs !== afterRead.ctimeMs ||
      contents.length !== opened.size
    ) {
      throw new Error('mission attachment changed while hashing');
    }
    requireWorkspaceRootAuthority(options.workspaceRootAuthority);
    const sealed = writeSealedAttachment(canonical, contents, options);
    requireWorkspaceRootAuthority(options.workspaceRootAuthority);
    return sealed;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function revalidateSealedAttachmentSnapshots(
  snapshots: readonly MissionAttachmentSnapshot[],
  options: SealedMissionAttachmentLifecycleOptions & {
    readonly workspaceRootAuthority: WorkspaceRootAuthority;
  },
): MissionAttachmentSnapshot[] {
  assertAttachmentCount(snapshots);
  const workspaceRoot = requireWorkspaceRootAuthority(
    options.workspaceRootAuthority,
  );
  const root = sealedAttachmentDirectory(options, false);
  if (root === workspaceRoot || isInside(workspaceRoot, root)) {
    throw new Error('sealed attachment storage must remain outside the checkout');
  }
  if (!fs.existsSync(root)) {
    throw new Error('sealed attachment checkout namespace is absent');
  }
  const uid = expectedUid(options);
  const noFollow =
    'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const validated = snapshots.map((snapshot) => {
    assertSealedSnapshotMetadata(snapshot);
    assertSealedPath(snapshot, root);
    let fd: number | null = null;
    try {
      const before = fs.lstatSync(snapshot.path, { bigint: true });
      if (
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.nlink !== 1n ||
        !sealedFileModeIsImmutable(before) ||
        before.dev.toString() !== snapshot.device ||
        before.ino.toString() !== snapshot.inode ||
        (snapshot.ctimeNs !== undefined &&
          before.ctimeNs.toString() !== snapshot.ctimeNs) ||
        (snapshot.mtimeNs !== undefined &&
          before.mtimeNs.toString() !== snapshot.mtimeNs)
      ) {
        throw new Error('sealed attachment identity changed');
      }
      assertBigIntOwned(before, uid, 'sealed attachment');
      fd = fs.openSync(snapshot.path, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameBigIntFileIdentity(before, opened)) {
        throw new Error('sealed attachment changed while opening');
      }
      const contents = readExactFd(fd, snapshot.size);
      const after = fs.fstatSync(fd, { bigint: true });
      const pathAfter = fs.lstatSync(snapshot.path, { bigint: true });
      if (
        !sameBigIntFileIdentity(opened, after) ||
        !sameBigIntFileIdentity(opened, pathAfter) ||
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs ||
        after.size !== BigInt(snapshot.size) ||
        after.nlink !== 1n ||
        !sealedFileModeIsImmutable(after) ||
        fs.realpathSync(snapshot.path) !== snapshot.path ||
        createHash('sha256').update(contents).digest('hex') !== snapshot.sha256
      ) {
        throw new Error('sealed attachment hash or identity changed');
      }
      return Object.freeze({ ...snapshot });
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  });
  requireWorkspaceRootAuthority(options.workspaceRootAuthority);
  return validated;
}

export function releaseSealedAttachmentSnapshots(
  snapshots: readonly MissionAttachmentSnapshot[],
  options: SealedMissionAttachmentLifecycleOptions,
): number {
  assertAttachmentCount(snapshots);
  const root = sealedAttachmentDirectory(options, false);
  if (!fs.existsSync(root)) return 0;
  const uid = expectedUid(options);
  let removed = 0;
  for (const snapshot of snapshots) {
    try {
      assertSealedSnapshotMetadata(snapshot);
      assertSealedPath(snapshot, root);
      const current = fs.lstatSync(snapshot.path, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1n ||
        current.dev.toString() !== snapshot.device ||
        current.ino.toString() !== snapshot.inode ||
        (snapshot.ctimeNs !== undefined &&
          current.ctimeNs.toString() !== snapshot.ctimeNs) ||
        (snapshot.mtimeNs !== undefined &&
          current.mtimeNs.toString() !== snapshot.mtimeNs)
      ) {
        continue;
      }
      assertBigIntOwned(current, uid, 'sealed attachment');
      if (fs.realpathSync(snapshot.path) !== snapshot.path) continue;
      fs.unlinkSync(snapshot.path);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (removed > 0) {
    const directoryFd = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      fsyncDirectoryIfPosix(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
  return removed;
}

export interface SealedAttachmentOrphanSweepOptions
  extends SealedMissionAttachmentLifecycleOptions {
  readonly liveSnapshots: readonly MissionAttachmentSnapshot[];
  readonly now?: number;
  readonly minimumAgeMs?: number;
}

export function sweepSealedAttachmentOrphans(
  options: SealedAttachmentOrphanSweepOptions,
): number {
  const root = sealedAttachmentDirectory(options, false);
  if (!fs.existsSync(root)) return 0;
  const uid = expectedUid(options);
  const livePaths = new Set(
    options.liveSnapshots.map((snapshot) => path.resolve(snapshot.path)),
  );
  const cutoff =
    (options.now ?? Date.now()) -
    (options.minimumAgeMs ?? DEFAULT_ORPHAN_MINIMUM_AGE_MS);
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^[a-f0-9]{32,128}(?:\.[a-zA-Z0-9]{1,16})?$/.test(entry.name)
    ) {
      continue;
    }
    const candidate = path.join(root, entry.name);
    if (livePaths.has(candidate)) continue;
    const stat = fs.lstatSync(candidate, { bigint: true });
    assertBigIntOwned(stat, uid, 'sealed attachment orphan');
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      Number(stat.mtimeMs) > cutoff
    ) {
      continue;
    }
    fs.unlinkSync(candidate);
    removed += 1;
  }
  if (removed > 0) {
    const directoryFd = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      fsyncDirectoryIfPosix(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
  return removed;
}
