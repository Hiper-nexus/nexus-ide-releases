import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Handoff } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';

const MAX_SPRITESHEET_BYTES = 2.5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const CLOCK_SKEW_TOLERANCE_MS = 1_000;

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

type RecoveryStores = {
  readonly missions: Pick<
    ProjectDomainStoreSuite['missions'],
    'list' | 'setStatus'
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

function validatePackageArtifacts(
  artifacts: readonly unknown[],
  missionCreatedAt: number,
  codexHome: string,
): { packageDir: string } {
  const paths = artifacts
    .map(artifactPath)
    .filter((path): path is string => Boolean(path))
    .map(expandArtifactPath)
    .filter(Boolean);
  const spritePath = paths.find((path) => basename(path) === 'spritesheet.webp');
  const manifestPath = paths.find((path) => basename(path) === 'pet.json');
  if (!spritePath || !manifestPath) {
    throw new Error(
      'inclua nos artifacts os caminhos absolutos de spritesheet.webp e pet.json',
    );
  }

  const petRoot = realpathSync(join(codexHome, 'pets'));
  const spriteRealPath = realpathSync(spritePath);
  const manifestRealPath = realpathSync(manifestPath);
  if (
    !isWithin(petRoot, spriteRealPath) ||
    !isWithin(petRoot, manifestRealPath) ||
    dirname(spriteRealPath) !== dirname(manifestRealPath)
  ) {
    throw new Error('o pacote final deve estar em uma única pasta de ~/.codex/pets');
  }

  const spriteStat = statSync(spriteRealPath);
  const manifestStat = statSync(manifestRealPath);
  if (!spriteStat.isFile() || spriteStat.size === 0) {
    throw new Error('spritesheet.webp está ausente ou vazio');
  }
  if (spriteStat.size > MAX_SPRITESHEET_BYTES) {
    throw new Error('spritesheet.webp excede 2,5 MiB');
  }
  if (!manifestStat.isFile() || manifestStat.size === 0) {
    throw new Error('pet.json está ausente ou vazio');
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('pet.json excede 64 KiB');
  }
  if (
    spriteStat.mtimeMs + CLOCK_SKEW_TOLERANCE_MS < missionCreatedAt ||
    manifestStat.mtimeMs + CLOCK_SKEW_TOLERANCE_MS < missionCreatedAt
  ) {
    throw new Error('o pacote informado é anterior a esta missão');
  }

  const webpHeader = readFileSync(spriteRealPath).subarray(0, 12);
  if (
    webpHeader.length < 12 ||
    webpHeader.toString('ascii', 0, 4) !== 'RIFF' ||
    webpHeader.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('spritesheet.webp não é um WebP válido');
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestRealPath, 'utf8'));
  } catch {
    throw new Error('pet.json não contém JSON válido');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('pet.json não contém um manifesto válido');
  }
  const pet = manifest as Record<string, unknown>;
  if (
    typeof pet.id !== 'string' ||
    pet.id !== basename(dirname(manifestRealPath)) ||
    pet.spriteVersionNumber !== 2 ||
    pet.spritesheetPath !== 'spritesheet.webp'
  ) {
    throw new Error(
      'pet.json deve usar o id da pasta, spriteVersionNumber 2 e spritesheetPath spritesheet.webp',
    );
  }
  return { packageDir: dirname(manifestRealPath) };
}

function validatePackage(
  handoff: Handoff,
  missionCreatedAt: number,
  codexHome: string,
): { packageDir: string } {
  return validatePackageArtifacts(
    handoff.artifacts,
    missionCreatedAt,
    codexHome,
  );
}

function recoverablePackages(
  missionCreatedAt: number,
  codexHome: string,
): string[] {
  let petRoot: string;
  try {
    petRoot = realpathSync(join(codexHome, 'pets'));
  } catch {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(petRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages: string[] = [];
  for (const entry of entries) {
    // Recovery ignores symlinked package directories. The normal handoff
    // validator still canonicalizes every artifact before accepting it.
    if (!entry.isDirectory()) continue;
    const packageDir = join(petRoot, entry.name);
    try {
      const validated = validatePackageArtifacts(
        [
          join(packageDir, 'spritesheet.webp'),
          join(packageDir, 'pet.json'),
        ],
        missionCreatedAt,
        codexHome,
      );
      packages.push(validated.packageDir);
    } catch {
      // Missing, stale or malformed packages are not completion evidence.
    }
  }
  return packages;
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
  dependencies: Pick<PetStudioCompletionDependencies, 'codexHome'> = {},
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
  const candidates = recoverablePackages(mission.createdAt, codexHome);
  if (candidates.length !== 1) {
    return [
      {
        missionId: mission.id,
        completed: false,
        error:
          candidates.length === 0
            ? 'nenhum pacote Pet Studio recente e válido encontrado'
            : 'mais de um pacote Pet Studio recente; recuperação ambígua',
      },
    ];
  }

  stores.missions.setStatus(mission.id, 'done');
  return [
    {
      missionId: mission.id,
      completed: true,
      packageDir: candidates[0],
    },
  ];
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

  if (
    !handoff.sessionId ||
    !mission.orchestratorSessionId ||
    handoff.sessionId !== mission.orchestratorSessionId
  ) {
    return {
      handled: true,
      completed: false,
      error: 'a entrega não veio da sessão Pet Maker vinculada à missão',
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
    const validated = validatePackage(
      handoff,
      mission.createdAt,
      resolve(
        dependencies.codexHome ??
          process.env.CODEX_HOME ??
          join(homedir(), '.codex'),
      ),
    );
    stores.missions.setStatus(handoff.missionId, 'done');
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
