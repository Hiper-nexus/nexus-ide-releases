import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  PROJECT_IDENTITY_VERSION,
  PROJECT_MANIFEST_VERSION,
  legacyProjectManifestSchema,
  projectManifestSchema,
  quarantineProjectIdentity as quarantine,
  type ProjectExecutionScope,
  type ProjectManifest,
} from '../../shared/types';
export {
  ProjectIdentityQuarantineError,
  type ProjectIdentityQuarantineCode,
} from '../../shared/types';
import {
  collectGitRepositoryContext,
  compareRepositoryLineage,
  isGitCommitReachable,
  processGitRunner,
  repositoryLineageId,
  type GitRepositoryContext,
  type ProjectGitRunner,
} from './project-git-lineage';
export const PROJECT_MANIFEST_PATH = '.nexus/project.json';
const INSTALLATION_FILE = path.join(os.homedir(), '.nexus', 'installation.json');
const CHECKOUT_REGISTRY_FILE = path.join(
  os.homedir(),
  '.nexus',
  'checkouts.json',
);
const MAX_PROJECT_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKOUT_REGISTRY_BYTES = 1024 * 1024;
const MAX_CHECKOUT_TOKEN_BYTES = 4 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const CHECKOUT_REGISTRY_VERSION = 2 as const;
const LEGACY_CHECKOUT_REGISTRY_VERSION = 1 as const;
const CHECKOUT_TOKEN_VERSION = 1 as const;
const CHECKOUT_REGISTRY_LOCK_STALE_MS = 30_000;
interface InstallationState {
  schemaVersion: typeof PROJECT_IDENTITY_VERSION;
  installationId: string;
}
const checkoutIdSchema = z.string().regex(/^checkout-[a-f0-9]{32}$/);
const rootPathSchema = z.string().min(1).max(4096);
const timestampSchema = z.number().int().nonnegative();
const legacyCheckoutFields = {
  checkoutId: checkoutIdSchema,
  projectId: z.string().min(1).max(128),
  rootRealPath: rootPathSchema,
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
  birthtimeNs: z.string().regex(/^\d+$/),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
};
const checkoutRegistryV1Schema = z
  .object({
    schemaVersion: z.literal(LEGACY_CHECKOUT_REGISTRY_VERSION),
    installationId: z.string().min(1).max(128),
    entries: z.array(z.object(legacyCheckoutFields).strict()).max(10_000),
  })
  .strict();
const legacyFsCheckoutEntrySchema = z
  .object({ kind: z.literal('legacy-fs'), ...legacyCheckoutFields })
  .strict();
const gitTokenCheckoutEntrySchema = z
  .object({
    kind: z.literal('git-token'),
    checkoutId: checkoutIdSchema,
    checkoutToken: z.string().uuid(),
    projectId: z.string().uuid(),
    lineageId: z.string().regex(/^lineage-[a-f0-9]{64}$/),
    rootRealPath: rootPathSchema,
    createdAt: timestampSchema,
    lastSeenAt: timestampSchema,
  })
  .strict();
const checkoutRegistrySchema = z
  .object({
    schemaVersion: z.literal(CHECKOUT_REGISTRY_VERSION),
    installationId: z.string().min(1).max(128),
    entries: z
      .array(
        z.discriminatedUnion('kind', [
          legacyFsCheckoutEntrySchema,
          gitTokenCheckoutEntrySchema,
        ]),
      )
      .max(10_000),
  })
  .strict();
const checkoutTokenSchema = z
  .object({
    schemaVersion: z.literal(CHECKOUT_TOKEN_VERSION),
    checkoutToken: z.string().uuid(),
    projectId: z.string().uuid(),
  })
  .strict();
type CheckoutRegistry = z.infer<typeof checkoutRegistrySchema>;
type LegacyFsCheckoutEntry = z.infer<typeof legacyFsCheckoutEntrySchema>;
type GitTokenCheckoutEntry = z.infer<typeof gitTokenCheckoutEntrySchema>;
type CheckoutTokenState = z.infer<typeof checkoutTokenSchema>;
export interface ProjectIdentityResolveOptions {
  installationId?: string;
  checkoutRegistryFile?: string;
  gitRunner?: ProjectGitRunner;
}
interface ManifestIdentity {
  readonly projectId: string;
  readonly identitySource: 'manifest';
  readonly manifest: ProjectManifest;
  readonly repository: GitRepositoryContext;
  readonly lineageId: string;
}
interface ProvisionalIdentity {
  readonly projectId: string;
  readonly identitySource: 'provisional';
}
type ResolvedProjectIdentity = ManifestIdentity | ProvisionalIdentity;
function digestId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}
function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
function parseInstallationState(file: string): InstallationState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`invalid installation identity: ${file}`, { cause: error });
  }
  const value = raw as Partial<InstallationState> | null;
  if (
    value?.schemaVersion !== PROJECT_IDENTITY_VERSION ||
    typeof value.installationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.installationId,
    )
  ) {
    throw new Error(`invalid installation identity: ${file}`);
  }
  return value as InstallationState;
}
function publishExclusiveJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const candidate = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate, 'wx', PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(candidate, file);
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(candidate, { force: true });
  }
}
export function getOrCreateInstallationId(
  file: string = INSTALLATION_FILE,
): string {
  if (fs.existsSync(file)) return parseInstallationState(file).installationId;
  publishExclusiveJson(file, {
    schemaVersion: PROJECT_IDENTITY_VERSION,
    installationId: randomUUID(),
  } satisfies InstallationState);
  return parseInstallationState(file).installationId;
}
function canonicalWorkspaceRoot(root: string): string {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch (error) {
    throw new Error(`workspace cannot be resolved: ${root}`, { cause: error });
  }
  if (!fs.statSync(realRoot).isDirectory()) {
    throw new Error(`workspace is not a directory: ${root}`);
  }
  return realRoot;
}
function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}
function readBoundedJsonFile(
  file: string,
  maxBytes: number,
  label: string,
): unknown {
  let fd: number | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${label} is not a single-link regular file`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${label} is too large`);
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`invalid ${label}: ${file}${detail}`, { cause: error });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function readProjectManifest(rootRealPath: string, manifestFile: string): unknown {
  const realManifest = fs.realpathSync(manifestFile);
  if (!isInsideRoot(rootRealPath, realManifest)) {
    throw new Error(`project manifest resolves outside workspace: ${manifestFile}`);
  }
  const linkStat = fs.lstatSync(manifestFile);
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.nlink !== 1) {
    throw new Error(`project manifest must be a single-link regular file: ${manifestFile}`);
  }
  return readBoundedJsonFile(
    realManifest,
    MAX_PROJECT_MANIFEST_BYTES,
    'project manifest',
  );
}
function manifestError(file: string, issues: z.core.$ZodIssue[]): Error {
  return new Error(
    `invalid project manifest: ${file}: ${issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')}`,
  );
}
function projectIdentity(
  rootRealPath: string,
  runner: ProjectGitRunner,
): ResolvedProjectIdentity {
  const manifestFile = path.join(rootRealPath, PROJECT_MANIFEST_PATH);
  if (!fs.existsSync(manifestFile)) {
    return {
      projectId: digestId('local', rootRealPath),
      identitySource: 'provisional',
    };
  }
  const raw = readProjectManifest(rootRealPath, manifestFile);
  const legacy = legacyProjectManifestSchema.safeParse(raw);
  if (legacy.success) {
    quarantine(
      'legacy-manifest-unverified',
      `legacy project manifest is quarantined: ${manifestFile}`,
      `Confirme a origem do repositório e regenere ${PROJECT_MANIFEST_PATH} no schemaVersion ${PROJECT_MANIFEST_VERSION}; o projectId legado não será adotado automaticamente.`,
    );
  }
  const parsed = projectManifestSchema.safeParse(raw);
  if (!parsed.success) throw manifestError(manifestFile, parsed.error.issues);
  let repository: GitRepositoryContext;
  try {
    repository = collectGitRepositoryContext(rootRealPath, runner);
  } catch (error) {
    quarantine(
      'repository-lineage-unverifiable',
      `project manifest repository lineage cannot be verified: ${manifestFile}`,
      'Abra a raiz de um repositório Git íntegro; em clone shallow configure um origin portátil, ou use histórico completo.',
      error,
    );
  }
  const compatibility = compareRepositoryLineage(
    parsed.data.repository,
    repository.proof,
    (commit) => isGitCommitReachable(rootRealPath, commit, runner),
  );
  if (!compatibility.ok) {
    quarantine(
      compatibility.reason === 'mismatch'
        ? 'repository-lineage-mismatch'
        : 'repository-lineage-unverifiable',
      `project manifest is incompatible with this repository: ${compatibility.detail}`,
      `Não reutilize o manifesto copiado. Confirme a origem/histórico e regenere ${PROJECT_MANIFEST_PATH} para este repositório, ou abra o clone correto.`,
    );
  }
  return Object.freeze({
    projectId: parsed.data.projectId,
    identitySource: 'manifest',
    manifest: parsed.data,
    repository,
    lineageId: repositoryLineageId(parsed.data),
  });
}
export function createProjectManifest(
  workspaceRoot: string,
  input: { readonly projectId: string; readonly name?: string },
  runner: ProjectGitRunner = processGitRunner,
): ProjectManifest {
  const rootRealPath = canonicalWorkspaceRoot(workspaceRoot);
  let repository: GitRepositoryContext;
  try {
    repository = collectGitRepositoryContext(rootRealPath, runner);
  } catch (error) {
    quarantine(
      'repository-lineage-unverifiable',
      'cannot create a portable project manifest without Git lineage proof',
      'Inicialize/clone o repositório Git e garanta histórico completo ou um origin portátil antes de criar .nexus/project.json.',
      error,
    );
  }
  const manifest = projectManifestSchema.safeParse({
    schemaVersion: PROJECT_MANIFEST_VERSION,
    projectId: input.projectId,
    ...(input.name === undefined ? {} : { name: input.name }),
    repository: {
      vcs: 'git',
      originHashes: [...repository.proof.originHashes],
      rootCommits: repository.proof.isShallow
        ? []
        : [...repository.proof.rootCommits],
      anchorCommits:
        repository.proof.isShallow || !repository.proof.headCommit
          ? []
          : [repository.proof.headCommit],
    },
  });
  if (!manifest.success) {
    quarantine(
      'repository-lineage-unverifiable',
      'cannot create a project manifest from the available repository proof',
      'Use um clone completo ou configure um origin Git remoto sem credenciais/caminho local.',
      manifest.error,
    );
  }
  return Object.freeze({
    ...manifest.data,
    repository: Object.freeze({
      ...manifest.data.repository,
      originHashes: [...manifest.data.repository.originHashes],
      rootCommits: [...manifest.data.repository.rootCommits],
      anchorCommits: [...manifest.data.repository.anchorCommits],
    }),
  });
}
function readCheckoutRegistry(
  file: string,
  installationId: string,
): CheckoutRegistry {
  if (!fs.existsSync(file)) {
    return {
      schemaVersion: CHECKOUT_REGISTRY_VERSION,
      installationId,
      entries: [],
    };
  }
  const raw = readBoundedJsonFile(
    file,
    MAX_CHECKOUT_REGISTRY_BYTES,
    'checkout registry',
  );
  const current = checkoutRegistrySchema.safeParse(raw);
  if (current.success && current.data.installationId === installationId) {
    return current.data;
  }
  const legacy = checkoutRegistryV1Schema.safeParse(raw);
  if (!legacy.success || legacy.data.installationId !== installationId) {
    throw new Error(`invalid checkout registry: ${file}`);
  }
  return {
    schemaVersion: CHECKOUT_REGISTRY_VERSION,
    installationId,
    entries: legacy.data.entries.map((entry) => ({
      kind: 'legacy-fs',
      ...entry,
    })),
  };
}
function writeCheckoutRegistry(file: string, registry: CheckoutRegistry): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}
function acquireRegistryLock(file: string): () => void {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tryAcquire = (): number => fs.openSync(lockFile, 'wx', PRIVATE_FILE_MODE);
  let fd: number;
  try {
    fd = tryAcquire();
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST')) throw error;
    let isStale = false;
    try {
      isStale =
        Date.now() - fs.statSync(lockFile).mtimeMs >
        CHECKOUT_REGISTRY_LOCK_STALE_MS;
    } catch {
      // The lock owner may have released it between open and stat.
    }
    if (!isStale) {
      throw new Error(`checkout registry is busy: ${file}`, { cause: error });
    }
    fs.rmSync(lockFile, { force: true });
    fd = tryAcquire();
  }
  fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
  fs.fsyncSync(fd);
  return () => {
    try {
      fs.closeSync(fd);
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  };
}
function checkoutFingerprint(rootRealPath: string): Pick<
  LegacyFsCheckoutEntry,
  'device' | 'inode' | 'birthtimeNs'
> {
  const stat = fs.statSync(rootRealPath, { bigint: true });
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}
function sameLegacyCheckout(
  entry: LegacyFsCheckoutEntry,
  projectId: string,
  fingerprint: ReturnType<typeof checkoutFingerprint>,
): boolean {
  return (
    entry.projectId === projectId &&
    entry.device === fingerprint.device &&
    entry.inode === fingerprint.inode &&
    entry.birthtimeNs === fingerprint.birthtimeNs
  );
}
function ensureCheckoutTokenDirectory(gitDirRealPath: string): string {
  const directory = path.join(gitDirRealPath, 'nexus');
  if (!fs.existsSync(directory)) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!isErrnoCode(error, 'EEXIST')) throw error;
    }
  }
  const realDirectory = fs.realpathSync(directory);
  const stat = fs.lstatSync(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isInsideRoot(gitDirRealPath, realDirectory)
  ) {
    quarantine(
      'unsafe-git-administration',
      'unsafe Nexus checkout token directory in Git administration area',
      'Remova o symlink/diretório inseguro de .git/nexus e reabra o repositório.',
    );
  }
  return realDirectory;
}
function readCheckoutToken(file: string): CheckoutTokenState {
  let raw: unknown;
  try {
    raw = readBoundedJsonFile(file, MAX_CHECKOUT_TOKEN_BYTES, 'checkout token');
  } catch (error) {
    quarantine(
      'unsafe-git-administration',
      `unsafe Nexus checkout token: ${file}`,
      'Remova o token inseguro em .git/nexus somente após confirmar a identidade deste checkout.',
      error,
    );
  }
  const parsed = checkoutTokenSchema.safeParse(
    raw,
  );
  if (!parsed.success) {
    quarantine(
      'unsafe-git-administration',
      `invalid Nexus checkout token: ${file}`,
      'Remova o token inválido em .git/nexus somente após confirmar a identidade deste checkout.',
      parsed.error,
    );
  }
  return parsed.data;
}
function getOrCreateCheckoutToken(
  gitDirRealPath: string,
  projectId: string,
): CheckoutTokenState {
  const directory = ensureCheckoutTokenDirectory(gitDirRealPath);
  const file = path.join(directory, 'checkout.json');
  if (!fs.existsSync(file)) {
    publishExclusiveJson(file, {
      schemaVersion: CHECKOUT_TOKEN_VERSION,
      checkoutToken: randomUUID(),
      projectId,
    } satisfies CheckoutTokenState);
  }
  const token = readCheckoutToken(file);
  if (token.projectId !== projectId) {
    quarantine(
      'checkout-token-mismatch',
      'Git checkout token belongs to another project identity',
      'Confirme o repositório e remova .git/nexus/checkout.json antes de gerar uma nova identidade de checkout.',
    );
  }
  return token;
}
function existingCheckoutToken(
  rootRealPath: string,
  runner: ProjectGitRunner,
): CheckoutTokenState | null {
  let context: GitRepositoryContext;
  try {
    context = collectGitRepositoryContext(rootRealPath, runner);
  } catch {
    return null;
  }
  const file = path.join(context.gitDirRealPath, 'nexus', 'checkout.json');
  return fs.existsSync(file) ? readCheckoutToken(file) : null;
}
function assertNoLiveCheckoutDuplicate(
  entry: GitTokenCheckoutEntry,
  rootRealPath: string,
  runner: ProjectGitRunner,
): void {
  if (!fs.existsSync(entry.rootRealPath)) return;
  let previousRoot: string;
  try {
    previousRoot = fs.realpathSync(entry.rootRealPath);
  } catch {
    return;
  }
  if (previousRoot === rootRealPath) return;
  const previousToken = existingCheckoutToken(previousRoot, runner);
  if (previousToken?.checkoutToken === entry.checkoutToken) {
    quarantine(
      'duplicate-checkout-token',
      'the same checkout token is active at two workspace paths',
      'Remova a cópia duplicada ou apague .git/nexus/checkout.json nela após confirmar qual checkout deve continuar.',
    );
  }
}
function gitCheckoutEntry(
  checkoutId: string,
  token: CheckoutTokenState,
  identity: ManifestIdentity,
  rootRealPath: string,
  createdAt: number,
  lastSeenAt: number,
): GitTokenCheckoutEntry {
  return {
    kind: 'git-token',
    checkoutId,
    checkoutToken: token.checkoutToken,
    projectId: identity.projectId,
    lineageId: identity.lineageId,
    rootRealPath,
    createdAt,
    lastSeenAt,
  };
}

function resolveGitCheckoutId(
  file: string,
  installationId: string,
  identity: ManifestIdentity,
  rootRealPath: string,
  runner: ProjectGitRunner,
): string {
  const token = getOrCreateCheckoutToken(
    identity.repository.gitDirRealPath,
    identity.projectId,
  );
  const deterministicId = digestId(
    'checkout',
    installationId,
    token.checkoutToken,
  );
  const release = acquireRegistryLock(file);
  try {
    const registry = readCheckoutRegistry(file, installationId);
    const matches = registry.entries.filter(
      (entry): entry is GitTokenCheckoutEntry =>
        entry.kind === 'git-token' &&
        entry.checkoutToken === token.checkoutToken,
    );
    if (matches.length > 1) {
      throw new Error('invalid checkout registry: duplicate checkout token');
    }
    const now = Date.now();
    if (matches.length === 1) {
      const match = matches[0];
      if (match.projectId !== identity.projectId) {
        quarantine(
          'checkout-token-mismatch',
          'checkout registry token belongs to another project',
          'Confirme o repositório e remova a entrada/token conflitante antes de continuar.',
        );
      }
      assertNoLiveCheckoutDuplicate(match, rootRealPath, runner);
      const entries = registry.entries.map((entry) =>
        entry === match
          ? gitCheckoutEntry(
              match.checkoutId,
              token,
              identity,
              rootRealPath,
              match.createdAt,
              now,
            )
          : entry,
      );
      writeCheckoutRegistry(file, { ...registry, entries });
      return match.checkoutId;
    }

    const fingerprint = checkoutFingerprint(rootRealPath);
    const legacyMatches = registry.entries.filter(
      (entry): entry is LegacyFsCheckoutEntry =>
        entry.kind === 'legacy-fs' &&
        sameLegacyCheckout(entry, identity.projectId, fingerprint),
    );
    if (legacyMatches.length > 1) {
      throw new Error('invalid checkout registry: duplicate legacy fingerprint');
    }
    const legacy = legacyMatches[0];
    const checkoutId = legacy?.checkoutId ?? deterministicId;
    const collision = registry.entries.find(
      (entry) => entry.checkoutId === checkoutId && entry !== legacy,
    );
    if (collision) {
      throw new Error('invalid checkout registry: checkout id collision');
    }
    const next = gitCheckoutEntry(
      checkoutId,
      token,
      identity,
      rootRealPath,
      legacy?.createdAt ?? now,
      now,
    );
    writeCheckoutRegistry(file, {
      ...registry,
      entries: legacy
        ? registry.entries.map((entry) => (entry === legacy ? next : entry))
        : [...registry.entries, next],
    });
    return checkoutId;
  } finally {
    release();
  }
}

function resolveProvisionalCheckoutId(
  file: string,
  installationId: string,
  projectId: string,
  rootRealPath: string,
): string {
  const release = acquireRegistryLock(file);
  try {
    const registry = readCheckoutRegistry(file, installationId);
    const fingerprint = checkoutFingerprint(rootRealPath);
    const matches = registry.entries.filter(
      (entry): entry is LegacyFsCheckoutEntry =>
        entry.kind === 'legacy-fs' &&
        sameLegacyCheckout(entry, projectId, fingerprint),
    );
    if (matches.length > 1) {
      throw new Error('invalid checkout registry: duplicate checkout fingerprint');
    }
    const now = Date.now();
    if (matches.length === 1) {
      const match = matches[0];
      writeCheckoutRegistry(file, {
        ...registry,
        entries: registry.entries.map((entry) =>
          entry === match
            ? { ...match, rootRealPath, lastSeenAt: now }
            : entry,
        ),
      });
      return match.checkoutId;
    }
    const checkoutId = digestId('checkout', installationId, rootRealPath);
    const colliding = registry.entries.filter(
      (entry) => entry.checkoutId === checkoutId,
    );
    // O digest é determinístico no path: quando a pasta é apagada e recriada
    // no MESMO lugar (tmp de teste, re-clone, restore de backup), a
    // fingerprint muda mas o id não — a entrada antiga é o MESMO checkout,
    // não uma colisão de identidade. Sem esta cura o path fica preso para
    // sempre em "checkout id collision". Paths diferentes seguem fail-closed.
    if (
      colliding.length > 0 &&
      colliding.every(
        (entry) =>
          entry.kind === 'legacy-fs' && entry.rootRealPath === rootRealPath,
      )
    ) {
      const previous = colliding[0] as LegacyFsCheckoutEntry;
      const refreshed: LegacyFsCheckoutEntry = {
        kind: 'legacy-fs',
        checkoutId,
        projectId,
        rootRealPath,
        ...fingerprint,
        createdAt: previous.createdAt,
        lastSeenAt: now,
      };
      writeCheckoutRegistry(file, {
        ...registry,
        entries: registry.entries.map((entry) =>
          entry === previous ? refreshed : entry,
        ),
      });
      return checkoutId;
    }
    if (colliding.length > 0) {
      throw new Error('invalid checkout registry: checkout id collision');
    }
    const entry: LegacyFsCheckoutEntry = {
      kind: 'legacy-fs',
      checkoutId,
      projectId,
      rootRealPath,
      ...fingerprint,
      createdAt: now,
      lastSeenAt: now,
    };
    writeCheckoutRegistry(file, {
      ...registry,
      entries: [...registry.entries, entry],
    });
    return checkoutId;
  } finally {
    release();
  }
}

export function resolveProjectExecutionScope(
  workspaceRoot: string,
  installationOrOptions?: string | ProjectIdentityResolveOptions,
): ProjectExecutionScope {
  const options =
    typeof installationOrOptions === 'string'
      ? { installationId: installationOrOptions }
      : installationOrOptions ?? {};
  const installationId =
    options.installationId ?? getOrCreateInstallationId();
  const runner = options.gitRunner ?? processGitRunner;
  const rootRealPath = canonicalWorkspaceRoot(workspaceRoot);
  const identity = projectIdentity(rootRealPath, runner);
  const checkoutRegistryFile =
    typeof installationOrOptions === 'string'
      ? null
      : options.checkoutRegistryFile ?? CHECKOUT_REGISTRY_FILE;
  const checkoutId =
    identity.identitySource === 'manifest'
      ? checkoutRegistryFile
        ? resolveGitCheckoutId(
            checkoutRegistryFile,
            installationId,
            identity,
            rootRealPath,
            runner,
          )
        : quarantine(
            'checkout-registry-required',
            'manifested project checkout requires the installation registry',
            'Reabra o repositório com o registry padrão ~/.nexus/checkouts.json para detectar tokens duplicados com segurança.',
          )
      : checkoutRegistryFile
        ? resolveProvisionalCheckoutId(
            checkoutRegistryFile,
            installationId,
            identity.projectId,
            rootRealPath,
          )
        : digestId('checkout', installationId, rootRealPath);
  return Object.freeze({
    version: PROJECT_IDENTITY_VERSION,
    installationId,
    projectId: identity.projectId,
    checkoutId,
    rootRealPath,
    identitySource: identity.identitySource,
  });
}
