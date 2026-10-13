import { missionExecutionScope } from './mission-execution-scope';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Handoff } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { missionResultSchema } from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import { readWebpDimensions } from '../pet/pet-library';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import type { MissionEngine } from './mission-engine';
import { missionEngineForScope } from './mission-engine-registry';
import { MissionLeadershipError, type MissionLeader } from './mission-leadership';
import { getMissionLeadership } from './mission-leadership-runtime';
import { removeTreeSync } from '../util/remove-tree';

const MAX_SPRITESHEET_BYTES = 2.5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const CLOCK_SKEW_TOLERANCE_MS = 1_000;
const PET_STUDIO_SHEET_WIDTH = 1_536;
const PET_STUDIO_SHEET_HEIGHT = 2_288;

type CompletionStores = {
  readonly missions: Pick<
    ProjectDomainStoreSuite['missions'],
    'get' | 'setStatus'
  >;
  readonly handoffs: Pick<
    ProjectDomainStoreSuite['handoffs'],
    'markSubmitted' | 'markConsumed'
  >;
};
type CompletionMission = NonNullable<
  ReturnType<CompletionStores['missions']['get']>
>;

type RecoveryStores = {
  readonly scope: ProjectExecutionScope;
  readonly missions: Pick<
    ProjectDomainStoreSuite['missions'],
    'get' | 'list'
  >;
};

export interface PetStudioCompletionResult {
  readonly handled: true;
  readonly completed: boolean;
  readonly packageDir?: string;
  readonly error?: string;
}

interface PetStudioCompletionDependencies {
  readonly getStores?: (scope: ProjectExecutionScope) => CompletionStores;
  readonly codexHome?: string;
  /** Test seam; production always uses the main-owned canonical scope root. */
  readonly workspaceRoot?: string;
  readonly missionEngine?: Pick<MissionEngine, 'completeVerified'>;
  /** Injetável para testes; produção usa `getMissionLeadership().resolveMissionLeader`. */
  readonly resolveMissionLeader?: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => MissionLeader | null;
}

function artifactPath(artifact: unknown): string | null {
  if (typeof artifact === 'string') return artifact;
  if (!artifact || typeof artifact !== 'object') return null;
  const candidate = (artifact as { path?: unknown }).path;
  return typeof candidate === 'string' ? candidate : null;
}

function expandArtifactPath(rawPath: string): string {
  if (rawPath === '~') return homedir();
  if (rawPath.startsWith('~/')) return join(homedir(), rawPath.slice(2));
  return isAbsolute(rawPath) ? resolve(rawPath) : '';
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function consume(
  stores: CompletionStores,
  handoffId: string,
  missionId: string,
): void {
  // A fresh handoff is queued. markConsumed deliberately accepts only the
  // submitted/acknowledged states, so preserve the durable transition order.
  stores.handoffs.markSubmitted(handoffId);
  stores.handoffs.markConsumed(handoffId, missionId);
}

interface BoundWorkspaceFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function readBoundWorkspaceFile(
  rawPath: string,
  workspaceRoot: string,
  maxBytes: number,
  label: string,
): BoundWorkspaceFile {
  const expanded = expandArtifactPath(rawPath);
  if (!expanded) {
    throw new Error(`${label} deve usar caminho absoluto dentro do workspace`);
  }
  const workspaceReal = realpathSync(workspaceRoot);
  const beforeReal = realpathSync(expanded);
  if (!isWithin(workspaceReal, beforeReal)) {
    throw new Error(`${label} deve permanecer dentro do workspace autorizado`);
  }

  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(expanded, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size === 0) {
      throw new Error(`${label} está ausente ou vazio`);
    }
    if (before.size > maxBytes) {
      throw new Error(
        label === 'spritesheet.webp'
          ? 'spritesheet.webp excede 2,5 MiB'
          : 'pet.json excede 64 KiB',
      );
    }

    // Bind the canonical name to the already-open descriptor. A parent
    // symlink swap after this point cannot redirect the bytes being read.
    const openedReal = realpathSync(expanded);
    const named = statSync(openedReal);
    if (
      !isWithin(workspaceReal, openedReal) ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error(`${label} mudou durante a validação`);
    }

    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.length !== before.size
    ) {
      throw new Error(`${label} mudou durante a leitura`);
    }
    return {
      path: openedReal,
      bytes,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function assertValidPetPackageBytes(
  sprite: BoundWorkspaceFile,
  manifestFile: BoundWorkspaceFile,
  missionCreatedAt: number,
): { readonly id: string; readonly manifest: Record<string, unknown> } {
  if (
    sprite.mtimeMs + CLOCK_SKEW_TOLERANCE_MS < missionCreatedAt ||
    manifestFile.mtimeMs + CLOCK_SKEW_TOLERANCE_MS < missionCreatedAt ||
    sprite.ctimeMs + CLOCK_SKEW_TOLERANCE_MS < missionCreatedAt ||
    manifestFile.ctimeMs + CLOCK_SKEW_TOLERANCE_MS < missionCreatedAt
  ) {
    throw new Error('o pacote informado é anterior a esta missão');
  }
  const dimensions = readWebpDimensions(sprite.bytes);
  if (!dimensions) {
    throw new Error('spritesheet.webp não é um WebP estruturalmente válido');
  }
  if (
    dimensions.width !== PET_STUDIO_SHEET_WIDTH ||
    dimensions.height !== PET_STUDIO_SHEET_HEIGHT
  ) {
    throw new Error(
      `spritesheet.webp deve medir exatamente ${PET_STUDIO_SHEET_WIDTH}×${PET_STUDIO_SHEET_HEIGHT} px (8×11)`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
  } catch {
    throw new Error('pet.json não contém JSON válido');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('pet.json não contém um manifesto válido');
  }
  const pet = manifest as Record<string, unknown>;
  const id = typeof pet.id === 'string' ? pet.id : '';
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) ||
    id !== basename(dirname(manifestFile.path)) ||
    dirname(sprite.path) !== dirname(manifestFile.path) ||
    pet.spriteVersionNumber !== 2 ||
    pet.spritesheetPath !== 'spritesheet.webp'
  ) {
    throw new Error(
      'pet.json deve usar o id seguro da pasta, spriteVersionNumber 2 e spritesheetPath spritesheet.webp',
    );
  }
  return { id, manifest: pet };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function missionOutputRoot(
  workspaceRoot: string,
  missionId: string,
): string {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(missionId)) {
    throw new Error('id de missão Pet Studio não é seguro para o output');
  }
  const workspaceReal = realpathSync(workspaceRoot);
  const expected = join(
    workspaceReal,
    'artifacts',
    'nexus-pet-studio',
    missionId,
  );
  let outputReal: string;
  try {
    outputReal = realpathSync(expected);
  } catch {
    throw new Error(
      `output Pet Studio desta missão ainda não existe: ${expected}`,
    );
  }
  if (outputReal !== expected) {
    throw new Error('output Pet Studio não pode atravessar symlink');
  }
  return outputReal;
}

function fsyncPath(file: string): void {
  // No Windows o fsync exige handle de escrita (O_RDONLY dá EPERM) e não há
  // fsync de diretório — o rename já é o commit nessa plataforma.
  if (process.platform === 'win32' && statSync(file).isDirectory()) return;
  const fd = openSync(
    file,
    process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface BoundWorkspacePetPackage {
  readonly sprite: BoundWorkspaceFile;
  readonly manifest: BoundWorkspaceFile;
  readonly id: string;
}

function bindWorkspacePackage(
  artifacts: readonly unknown[],
  missionId: string,
  missionCreatedAt: number,
  workspaceRoot: string,
): BoundWorkspacePetPackage {
  const paths = artifacts
    .map(artifactPath)
    .filter((value): value is string => Boolean(value));
  const spritePath = paths.find((value) => basename(value) === 'spritesheet.webp');
  const manifestPath = paths.find((value) => basename(value) === 'pet.json');
  if (!spritePath || !manifestPath) {
    throw new Error(
      'inclua nos artifacts os caminhos absolutos do workspace para spritesheet.webp e pet.json',
    );
  }

  const outputRoot = missionOutputRoot(workspaceRoot, missionId);
  const sprite = readBoundWorkspaceFile(
    spritePath,
    outputRoot,
    MAX_SPRITESHEET_BYTES,
    'spritesheet.webp',
  );
  const manifest = readBoundWorkspaceFile(
    manifestPath,
    outputRoot,
    MAX_MANIFEST_BYTES,
    'pet.json',
  );
  const validated = assertValidPetPackageBytes(
    sprite,
    manifest,
    missionCreatedAt,
  );
  // Preserve the caller's lexical workspace prefix (macOS commonly exposes
  // /var through /private/var) while separately requiring the descriptor's
  // canonical destination. This rejects package-level symlinks without
  // rejecting the trusted scope root merely because the OS aliases it.
  const lexicalOutputRoot = join(
    resolve(workspaceRoot),
    'artifacts',
    'nexus-pet-studio',
    missionId,
  );
  const lexicalPackageDir = join(lexicalOutputRoot, validated.id);
  const expectedPackageDir = join(outputRoot, validated.id);
  const expectedSpritePath = join(expectedPackageDir, 'spritesheet.webp');
  const expectedManifestPath = join(expectedPackageDir, 'pet.json');
  const namedSpritePath = resolve(expandArtifactPath(spritePath));
  const namedManifestPath = resolve(expandArtifactPath(manifestPath));
  const lexicalSpritePath = join(lexicalPackageDir, 'spritesheet.webp');
  const lexicalManifestPath = join(lexicalPackageDir, 'pet.json');
  if (
    (namedSpritePath !== lexicalSpritePath &&
      namedSpritePath !== expectedSpritePath) ||
    (namedManifestPath !== lexicalManifestPath &&
      namedManifestPath !== expectedManifestPath) ||
    sprite.path !== expectedSpritePath ||
    manifest.path !== expectedManifestPath
  ) {
    throw new Error(
      'o pacote deve usar arquivos canônicos em um filho direto, sem symlink, do output exato desta missão',
    );
  }
  return { sprite, manifest, id: validated.id };
}

/**
 * Pet Maker never writes the real provider home. Main binds both workspace
 * files to descriptors, validates the package, then installs new bytes under
 * a fresh directory in the local pet catalog. Existing pets are never
 * overwritten.
 */
function installWorkspacePackage(
  artifacts: readonly unknown[],
  missionId: string,
  missionCreatedAt: number,
  workspaceRoot: string,
  codexHome: string,
): { packageDir: string } {
  const bound = bindWorkspacePackage(
    artifacts,
    missionId,
    missionCreatedAt,
    workspaceRoot,
  );
  const { sprite, manifest, id } = bound;

  const petsPath = join(resolve(codexHome), 'pets');
  mkdirSync(petsPath, { recursive: true, mode: 0o700 });
  const petRoot = realpathSync(petsPath);
  const target = join(petRoot, id);
  try {
    statSync(target);
    if (realpathSync(target) !== target) {
      throw new Error(
        `o pet existente com id ${id} não pode ser um symlink`,
      );
    }
    const installedSprite = readBoundWorkspaceFile(
      join(target, 'spritesheet.webp'),
      petRoot,
      MAX_SPRITESHEET_BYTES,
      'spritesheet.webp',
    );
    const installedManifest = readBoundWorkspaceFile(
      join(target, 'pet.json'),
      petRoot,
      MAX_MANIFEST_BYTES,
      'pet.json',
    );
    if (
      sha256(installedSprite.bytes) === sha256(sprite.bytes) &&
      sha256(installedManifest.bytes) === sha256(manifest.bytes)
    ) {
      return { packageDir: realpathSync(target) };
    }
    throw new Error(
      `já existe um pet diferente com id ${id}; gere um id novo para não sobrescrever dados`,
    );
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw cause;
  }

  const staging = mkdtempSync(join(petRoot, '.nexus-install-'));
  try {
    writeFileSync(join(staging, 'spritesheet.webp'), sprite.bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(join(staging, 'pet.json'), manifest.bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    fsyncPath(join(staging, 'spritesheet.webp'));
    fsyncPath(join(staging, 'pet.json'));
    fsyncPath(staging);
    renameSync(staging, target);
    fsyncPath(petRoot);
  } catch (cause) {
    removeTreeSync(staging, { recursive: true, force: true });
    throw cause;
  }
  return { packageDir: realpathSync(target) };
}

function recoverablePackageArtifacts(
  missionId: string,
  missionCreatedAt: number,
  workspaceRoot: string,
): unknown[][] {
  let outputRoot: string;
  try {
    outputRoot = missionOutputRoot(workspaceRoot, missionId);
  } catch {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(outputRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages: unknown[][] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(outputRoot, entry.name);
    const artifacts = [
      join(packageDir, 'spritesheet.webp'),
      join(packageDir, 'pet.json'),
    ];
    try {
      bindWorkspacePackage(
        artifacts,
        missionId,
        missionCreatedAt,
        workspaceRoot,
      );
      packages.push(artifacts);
    } catch {
      // Missing, stale or malformed packages are not completion evidence.
    }
  }
  return packages;
}

function completeInstalledPetMission(
  stores: {
    readonly missions: Pick<ProjectDomainStoreSuite['missions'], 'get'>;
  },
  scope: ProjectExecutionScope,
  mission: CompletionMission,
  missionEngine: Pick<MissionEngine, 'completeVerified'>,
  packageDir: string,
  summary: string,
  evidenceIds: readonly string[],
): CompletionMission {
  const result = missionResultSchema.parse({
    outcome: 'success',
    summary,
    evidenceIds: [...new Set(evidenceIds)].slice(0, 64),
    artifactRefs: [packageDir],
  });
  const completionEntry = `## Pet Studio concluído\n${summary}\nPacote instalado: ${packageDir}`;
  const learnings = (
    mission.learnings.trim()
      ? `${mission.learnings}\n\n${completionEntry}`
      : completionEntry
  ).slice(-65_536);
  missionEngine.completeVerified(scope, {
    missionId: mission.id,
    expectedStatus: 'running',
    expectedIntentState: mission.intentState ?? 'legacy',
    expectedUpdatedAt: mission.updatedAt,
    expectedIntentVersion: mission.intentVersion ?? 0,
    learnings,
    result,
  });
  const completed = stores.missions.get(mission.id);
  if (completed?.status !== 'done' || !completed.result) {
    throw new Error(
      'MissionEngine did not persist the canonical Pet Studio result',
    );
  }
  return completed;
}

export interface PetStudioRecoveryResult {
  readonly missionId: string;
  readonly completed: boolean;
  readonly packageDir?: string;
  readonly error?: string;
}

/**
 * Crash/restart recovery for a maker that wrote the package but could not
 * submit its final handoff. Strict by design: one running Pet Studio mission
 * and exactly one fresh valid package. Ambiguity never closes a mission.
 */
export function reconcileCompletedPetStudioMissions(
  stores: RecoveryStores,
  dependencies: Pick<
    PetStudioCompletionDependencies,
    'codexHome' | 'workspaceRoot' | 'missionEngine'
  > = {},
): PetStudioRecoveryResult[] {
  const missions = stores.missions
    .list()
    .filter(
      (mission) =>
        mission.squadId === PET_STUDIO_SQUAD_ID &&
        mission.status === 'running',
    );
  if (missions.length !== 1) return [];

  const mission = missions[0]!;
  const codexHome = resolve(
    dependencies.codexHome ??
      process.env.CODEX_HOME ??
      join(homedir(), '.codex'),
  );
  const workspaceRoot = dependencies.workspaceRoot;
  if (!workspaceRoot) {
    return [
      {
        missionId: mission.id,
        completed: false,
        error: 'workspace canônico indisponível para recuperar o Pet Studio',
      },
    ];
  }
  const candidates = recoverablePackageArtifacts(
    mission.id,
    mission.createdAt,
    resolve(workspaceRoot),
  );
  if (candidates.length !== 1) {
    return [
      {
        missionId: mission.id,
        completed: false,
        error:
          candidates.length === 0
            ? 'nenhum pacote Pet Studio recente e válido no output desta missão'
            : 'mais de um pacote Pet Studio recente; recuperação ambígua',
      },
    ];
  }

  try {
    const installed = installWorkspacePackage(
      candidates[0]!,
      mission.id,
      mission.createdAt,
      resolve(workspaceRoot),
      codexHome,
    );
    completeInstalledPetMission(
      stores,
      stores.scope,
      mission,
      dependencies.missionEngine ?? missionEngineForScope(stores.scope),
      installed.packageDir,
      `Pet Studio recuperado após reinicialização e instalado em ${installed.packageDir}.`,
      [],
    );
    return [
      {
        missionId: mission.id,
        completed: true,
        packageDir: installed.packageDir,
      },
    ];
  } catch (cause) {
    return [
      {
        missionId: mission.id,
        completed: false,
        error:
          cause instanceof Error
            ? cause.message
            : 'não foi possível reinstalar o pacote Pet Studio',
      },
    ];
  }
}

/**
 * Dedicated completion boundary for the fixed, single-session Pet Studio.
 * It intentionally bypasses the code-review workflow only after validating
 * the final pet package on disk. All other squads keep the normal PREVC gate.
 */
export function completePetStudioHandoff(
  handoff: Handoff,
  scope: ProjectExecutionScope,
  dependencies: PetStudioCompletionDependencies = {},
): PetStudioCompletionResult | null {
  const stores = (dependencies.getStores ?? getProjectDomainStores)(scope);
  if (!handoff.missionId) return null;
  const mission = stores.missions.get(handoff.missionId);
  if (!mission || mission.squadId !== PET_STUDIO_SQUAD_ID) return null;

  let leader: MissionLeader | null;
  try {
    leader = dependencies.resolveMissionLeader
      ? dependencies.resolveMissionLeader(scope, handoff.missionId)
      : getMissionLeadership().resolveMissionLeader(scope, handoff.missionId);
  } catch (error) {
    if (!(error instanceof MissionLeadershipError)) throw error;
    return {
      handled: true,
      completed: false,
      error: `liderança da missão em conflito (${error.code}) — entrega recusada até reconciliar`,
    };
  }
  if (
    !handoff.sessionId ||
    !leader?.proven ||
    handoff.sessionId !== leader.sessionId
  ) {
    return {
      handled: true,
      completed: false,
      error: 'a entrega não veio da sessão Pet Maker vinculada à missão',
    };
  }
  const provenance = handoff.mcpProvenance;
  if (
    handoff.authorityOrigin !== 'agent' ||
    !provenance ||
    provenance.toolName !== 'nexus_handoff_submit' ||
    (provenance.source !== 'http-mcp' && provenance.source !== 'acp-stdio') ||
    provenance.missionId !== handoff.missionId ||
    provenance.sessionId !== handoff.sessionId ||
    provenance.issuedAt + CLOCK_SKEW_TOLERANCE_MS < mission.createdAt
  ) {
    return {
      handled: true,
      completed: false,
      error:
        'a entrega Pet Studio exige provenance física do nexus_handoff_submit desta missão e sessão',
    };
  }

  if (handoff.status === 'failed' || handoff.status === 'blocked') {
    stores.missions.setStatus(handoff.missionId, handoff.status);
    consume(stores, handoff.id, handoff.missionId);
    return {
      handled: true,
      completed: false,
      error: `missão Pet Studio encerrada como ${handoff.status}`,
    };
  }
  if (handoff.status !== 'success') {
    return {
      handled: true,
      completed: false,
      error: 'o Pet Studio continua em execução até entregar um pacote final válido',
    };
  }

  try {
    const validated = installWorkspacePackage(
      handoff.artifacts,
      handoff.missionId,
      mission.createdAt,
      resolve(dependencies.workspaceRoot ?? missionExecutionScope(scope, mission).rootRealPath),
      resolve(
        dependencies.codexHome ??
          process.env.CODEX_HOME ??
          join(homedir(), '.codex'),
      ),
    );
    completeInstalledPetMission(
      stores,
      scope,
      mission,
      dependencies.missionEngine ?? missionEngineForScope(scope),
      validated.packageDir,
      handoff.summary ||
        `Pet Studio validado e instalado em ${validated.packageDir}.`,
      handoff.evidenceIds,
    );
    consume(stores, handoff.id, handoff.missionId);
    return { handled: true, completed: true, ...validated };
  } catch (cause) {
    return {
      handled: true,
      completed: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'não foi possível validar o pacote final do pet',
    };
  }
}
