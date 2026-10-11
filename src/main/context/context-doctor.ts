import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ensureWorkspaceDirectory,
  openWorkspaceFileForRead,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from '../orch/workspace-file';
import {
  isInsidePath,
  resolvePathCandidateForScope,
  resolveRootForScope,
} from '../orch/workspace-path';
import { detectContextConflicts } from './ambiguity-engine';
import { canonicalJson } from './canonical-json';
import {
  inspectContextAttestations,
  type ContextAttestationDiagnostic,
} from './context-attestation';
import {
  authorityFactLocators,
  partitionAttestationDiagnostics,
} from './context-attestation-readiness';
import { ingestProjectContext } from './context-ingestor';
import type { SensorDefinition } from './sensor-broker';

const POLICY_PATH = '.context/config/policy.json';
const SENSORS_PATH = '.context/config/sensors.json';
const DESIGN_SYSTEM_SENSOR_SOURCE_NAME = 'design-system-sensor.mjs';
const DESIGN_SYSTEM_SENSOR_TARGET_DIR = '.context/nexus/sensors';
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
export const BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET =
  `${DESIGN_SYSTEM_SENSOR_TARGET_DIR}/${DESIGN_SYSTEM_SENSOR_SOURCE_NAME}`;
const REQUIRED_BUSINESS_DOCS = [
  '.context/docs/project-overview.md',
  '.context/docs/business-model.md',
  '.context/docs/domain-glossary.md',
] as const;
const REQUIRED_TECHNICAL_DOCS = [
  '.context/docs/architecture.md',
  '.context/docs/testing.md',
] as const;

const riskSchema = z.enum(['low', 'medium', 'high', 'critical']);
const severitySchema = z.enum(['critical', 'high']);
const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('enforce'),
    protectedPaths: z.array(z.string().trim().min(1).max(512)).min(1).max(128),
    evidence: z
      .object({
        trustedProducer: z.literal('nexus'),
        bind: z
          .array(
            z.enum([
              'projectId',
              'checkoutId',
              'missionId',
              'baseSha',
              'headSha',
              'diffHash',
              'contractHash',
              'contextHash',
              'sensorConfigHash',
            ]),
          )
          .min(9)
          .max(9),
        blockOnSeverities: z.array(severitySchema).min(2).max(2),
      })
      .strict(),
    review: z
      .object({
        requireIndependentAuthor: z.literal(true),
        requireDifferentProviderFor: z.array(riskSchema).max(4),
        minimumReviewers: z
          .object({
            high: z.number().int().min(1).max(16),
            critical: z.number().int().min(2).max(16),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, context) => {
    const bindings = new Set(policy.evidence.bind);
    if (bindings.size !== 9) {
      context.addIssue({ code: 'custom', message: 'evidence bindings must be unique and complete' });
    }
    if (!policy.evidence.blockOnSeverities.includes('critical') ||
        !policy.evidence.blockOnSeverities.includes('high')) {
      context.addIssue({ code: 'custom', message: 'critical and high findings must block' });
    }
    if (policy.review.requireDifferentProviderFor.length > 0) {
      context.addIssue({
        code: 'custom',
        message:
          'provider labels are not reviewer identities; requireDifferentProviderFor must be empty',
      });
    }
  });

const sensorDefinitionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    command: z
      .array(z.string().min(1).max(65_536).refine((value) => !value.includes('\0')))
      .min(1)
      .max(1_024),
    timeoutMs: z.number().int().min(1).max(15 * 60_000),
    network: z.literal(false),
    cwd: z.string().max(4_096).optional(),
  })
  .strict();
const sensorsSchema = z
  .object({
    schemaVersion: z.literal(1),
    sensors: z.array(sensorDefinitionSchema).min(1).max(256),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.sensors.map((sensor) => sensor.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'sensor IDs must be unique' });
    }
  });

export interface LoadedContextConfiguration {
  readonly policyHash: string;
  readonly sensorConfigHash: string;
  readonly sensors: readonly SensorDefinition[];
}

export type ContextReadinessCode =
  | 'missing-business-context'
  | 'missing-technical-context'
  | 'missing-structured-invariants'
  | 'missing-policy'
  | 'invalid-policy'
  | 'missing-sensors'
  | 'invalid-sensors'
  | 'missing-required-sensors'
  | 'missing-quality-sensors'
  | 'missing-context-attestation'
  | 'invalid-context-attestation'
  | 'invalid-context'
  | 'context-conflict';

export interface ContextReadinessDiagnostic {
  readonly code: ContextReadinessCode;
  readonly message: string;
  readonly details?: readonly string[];
}

export interface ContextReadinessReport {
  readonly ready: boolean;
  readonly blockers: readonly ContextReadinessDiagnostic[];
  readonly warnings: readonly ContextReadinessDiagnostic[];
  readonly contextRevision?: string;
  readonly sensorIds: readonly string[];
}

export interface ContextReadinessOptions {
  readonly knownSymbols: ReadonlySet<string>;
  readonly requiredFactIds?: readonly string[];
  readonly impactedDomains?: readonly string[];
}

export interface ContextScaffoldResult {
  readonly created: readonly string[];
}

const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 1,
  mode: 'enforce',
    protectedPaths: Object.freeze(['.context']),
  evidence: Object.freeze({
    trustedProducer: 'nexus',
    bind: Object.freeze([
      'projectId',
      'checkoutId',
      'missionId',
      'baseSha',
      'headSha',
      'diffHash',
      'contractHash',
      'contextHash',
      'sensorConfigHash',
    ]),
    blockOnSeverities: Object.freeze(['critical', 'high']),
  }),
  review: Object.freeze({
    requireIndependentAuthor: true,
    requireDifferentProviderFor: Object.freeze([]),
    minimumReviewers: Object.freeze({ high: 1, critical: 2 }),
  }),
});

const CORE_PACKAGE_SENSOR_IDS = ['typecheck', 'unit'] as const;
const QUALITY_PACKAGE_SENSOR_IDS = [
  'dead-code',
  'duplication',
  'api-similarity',
  'coverage',
] as const;
const RECOMMENDED_PACKAGE_SENSOR_IDS = [
  ...CORE_PACKAGE_SENSOR_IDS,
  ...QUALITY_PACKAGE_SENSOR_IDS,
] as const;
type RecommendedPackageSensorId =
  (typeof RECOMMENDED_PACKAGE_SENSOR_IDS)[number];
type JavascriptPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const RECOMMENDED_PACKAGE_SENSOR_SCRIPTS =
  Object.freeze<Record<RecommendedPackageSensorId, string>>({
    typecheck: 'typecheck',
    unit: 'test',
    'dead-code': 'dead-code',
    duplication: 'duplication',
    'api-similarity': 'api-similarity',
    coverage: 'coverage',
  });
const DESIGN_SYSTEM_SENSOR = Object.freeze({
  id: 'design-system',
  command: Object.freeze(['node', BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET]),
  timeoutMs: 60_000,
  network: false as const,
});

interface PackageManifestCapabilities {
  readonly cwd: string;
  readonly scripts: ReadonlySet<string>;
  readonly packageManager?: JavascriptPackageManager;
}

interface PackageCwdResolution {
  readonly cwd: string;
  readonly exists: boolean;
}

function workspaceRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative === '' ? '.' : relative;
}

function pathExistsWithoutFollowing(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Canonicalizes an existing cwd and validates the deepest existing ancestor
 * for a future cwd. A not-yet-created project directory remains valid
 * declarative authority; traversal or a symlink ancestor escaping the
 * workspace never does.
 */
function resolvePackageCwd(
  scope: ProjectExecutionScope,
  requestedCwd?: string,
): PackageCwdResolution {
  const root = resolveRootForScope(scope);
  const candidate = resolvePathCandidateForScope(scope, requestedCwd ?? '.');
  let existing = candidate;
  while (!pathExistsWithoutFollowing(existing)) {
    if (existing === root) {
      throw new Error('sensor cwd has no existing workspace ancestor');
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error('sensor cwd escapes project scope');
    }
    existing = parent;
  }
  const existingReal = fs.realpathSync(existing);
  if (!isInsidePath(root, existingReal)) {
    throw new Error('sensor cwd escapes project scope');
  }
  const stat = fs.statSync(existingReal);
  if (!stat.isDirectory()) throw new Error('sensor cwd is not a directory');
  const suffix = path.relative(existing, candidate);
  const cwd = path.resolve(existingReal, suffix);
  if (!isInsidePath(root, cwd)) {
    throw new Error('sensor cwd escapes project scope');
  }
  return Object.freeze({
    cwd,
    exists: existing === candidate,
  });
}

function readBoundedPackageManifest(
  scope: ProjectExecutionScope,
  relativePackagePath: string,
): unknown {
  const handle = openWorkspaceFileForRead(scope, relativePackagePath);
  try {
    const initialSize = handle.stat.size;
    if (initialSize > MAX_PACKAGE_MANIFEST_BYTES) {
      throw new Error('package manifest exceeds 1 MiB');
    }
    const buffer = Buffer.alloc(initialSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(
        handle.fd,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStat = fs.fstatSync(handle.fd);
    if (
      offset > MAX_PACKAGE_MANIFEST_BYTES ||
      offset !== initialSize ||
      finalStat.size !== initialSize
    ) {
      throw new Error('package manifest changed during bounded read');
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally {
    handle.close();
  }
}

function readPackageManifest(
  scope: ProjectExecutionScope,
  location: PackageCwdResolution,
): PackageManifestCapabilities | undefined {
  if (!location.exists) return undefined;
  const relativePackagePath = path.join(
    workspaceRelativePath(scope.rootRealPath, location.cwd),
    'package.json',
  );
  try {
    const raw = readBoundedPackageManifest(scope, relativePackagePath);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const scripts = (raw as { readonly scripts?: unknown }).scripts;
    const packageManagerValue =
      (raw as { readonly packageManager?: unknown }).packageManager;
    const packageManagerMatch =
      typeof packageManagerValue === 'string'
        ? /^(npm|pnpm|yarn|bun)(?:@|$)/u.exec(
            packageManagerValue.trim().toLowerCase(),
          )
        : null;
    return Object.freeze({
      cwd: location.cwd,
      scripts: new Set(
        scripts && typeof scripts === 'object' && !Array.isArray(scripts)
          ? Object.entries(scripts)
              .filter(([, command]) => (
                typeof command === 'string' && command.trim().length > 0
              ))
              .map(([name]) => name)
          : [],
      ),
      packageManager:
        packageManagerMatch?.[1] as JavascriptPackageManager | undefined,
    });
  } catch {
    // A malformed or unreadable package manifest cannot confer capability.
    return undefined;
  }
}

function packageCommand(
  command: readonly string[],
): {
  readonly kind: 'package';
  readonly manager: JavascriptPackageManager;
  readonly script?: string;
} | {
  readonly kind: 'custom';
} {
  const executable = path.basename(command[0] ?? '')
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, '');
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    return { kind: 'custom' };
  }
  const manager = executable as JavascriptPackageManager;
  const first = command[1];
  const second = command[2];
  if (manager === 'npm') {
    if (first === 'test') {
      return { kind: 'package', manager, script: 'test' };
    }
    if (
      (first === 'run' || first === 'run-script') &&
      second
    ) {
      return { kind: 'package', manager, script: second };
    }
    return { kind: 'package', manager };
  }
  if (manager === 'bun') {
    // `bun test` invokes Bun's test runner; only `bun run test` executes the
    // package script declared by the project.
    if (first === 'run' && second) {
      return { kind: 'package', manager, script: second };
    }
    return { kind: 'package', manager };
  }
  if (first === 'run' && second) {
    return { kind: 'package', manager, script: second };
  }
  if (first) {
    return { kind: 'package', manager, script: first };
  }
  return { kind: 'package', manager };
}

function packageFileExists(
  scope: ProjectExecutionScope,
  cwd: string,
  filename: string,
): boolean {
  return fileExistsWithoutFollowing(
    scope,
    path.join(
      workspaceRelativePath(scope.rootRealPath, cwd),
      filename,
    ),
  );
}

function detectJavascriptPackageManager(
  scope: ProjectExecutionScope,
  manifest: PackageManifestCapabilities,
): JavascriptPackageManager {
  if (manifest.packageManager) return manifest.packageManager;
  if (
    packageFileExists(scope, manifest.cwd, 'pnpm-lock.yaml') ||
    packageFileExists(scope, manifest.cwd, 'pnpm-workspace.yaml')
  ) {
    return 'pnpm';
  }
  if (packageFileExists(scope, manifest.cwd, 'yarn.lock')) return 'yarn';
  if (
    packageFileExists(scope, manifest.cwd, 'bun.lock') ||
    packageFileExists(scope, manifest.cwd, 'bun.lockb')
  ) {
    return 'bun';
  }
  return 'npm';
}

function defaultPackageSensor(
  id: RecommendedPackageSensorId,
  manager: JavascriptPackageManager,
): Readonly<SensorDefinition> {
  const script = RECOMMENDED_PACKAGE_SENSOR_SCRIPTS[id];
  const command =
    manager === 'bun'
      ? [manager, 'run', script]
      : script === 'test'
        ? [manager, 'test']
        : [manager, 'run', script];
  return Object.freeze({
    id,
    command: Object.freeze(command),
    timeoutMs: 15 * 60_000,
    network: false as const,
  });
}

function isNexusDefaultPackageSensor(sensor: SensorDefinition): boolean {
  if (sensor.cwd !== undefined) return false;
  if (
    !RECOMMENDED_PACKAGE_SENSOR_IDS.includes(
      sensor.id as RecommendedPackageSensorId,
    )
  ) {
    return false;
  }
  const id = sensor.id as RecommendedPackageSensorId;
  const defaults: readonly (readonly string[])[] = [
    ...(['npm', 'pnpm', 'yarn', 'bun'] as const).map(
      (manager) => defaultPackageSensor(id, manager).command,
    ),
    ...(id === 'unit'
      ? [Object.freeze(['npm', 'test', '--', '--run'])]
      : []),
  ];
  return defaults.some(
    (command) => canonicalJson(command) === canonicalJson(sensor.command),
  );
}

function sensorCapabilityExists(
  scope: ProjectExecutionScope,
  sensor: SensorDefinition,
): boolean {
  let location: PackageCwdResolution;
  let manifest: PackageManifestCapabilities | undefined;
  try {
    location = resolvePackageCwd(scope, sensor.cwd);
    manifest = readPackageManifest(scope, location);
  } catch {
    // Traversal, symlink escape, or a malformed/oversized manifest can never
    // confer package capability.
    return false;
  }
  if (
    RECOMMENDED_PACKAGE_SENSOR_IDS.includes(
      sensor.id as RecommendedPackageSensorId,
    )
  ) {
    const command = packageCommand(sensor.command);
    if (command.kind === 'package') {
      const expected =
        RECOMMENDED_PACKAGE_SENSOR_SCRIPTS[
          sensor.id as RecommendedPackageSensorId
        ];
      // Recommended package gates cannot borrow the authority of a differently
      // named script. Additional argv remains deliberate, versioned project
      // authority and is passed without a shell by SensorBroker.
      if (command.script !== expected) {
        return false;
      }
      if (
        !manifest?.scripts.has(expected) &&
        isNexusDefaultPackageSensor(sensor)
      ) return false;
    }
  }
  if (
    sensor.id === DESIGN_SYSTEM_SENSOR.id &&
    canonicalJson(sensor.command) === canonicalJson(DESIGN_SYSTEM_SENSOR.command)
  ) {
    return isExactBundledDesignSystemSensor(scope);
  }
  return true;
}

/**
 * Filters declarative configuration by capabilities that physically exist in
 * this checkout. It prevents legacy npm defaults from becoming contract
 * authority in a greenfield repository with no package scripts.
 */
export function applicableContextSensors(
  scope: ProjectExecutionScope,
  sensors: readonly SensorDefinition[],
): readonly SensorDefinition[] {
  return Object.freeze(
    sensors.filter((sensor) => sensorCapabilityExists(scope, sensor)),
  );
}

/** Implicit PREVC gates supported by this checkout and its sensor config. */
export function recommendedProjectSensorIds(
  scope: ProjectExecutionScope,
  sensors: readonly SensorDefinition[],
): readonly string[] {
  const applicable = new Set(
    applicableContextSensors(scope, sensors).map((sensor) => sensor.id),
  );
  return Object.freeze(
    RECOMMENDED_PACKAGE_SENSOR_IDS.filter((id) => applicable.has(id)),
  );
}

function defaultSensorsForScope(scope: ProjectExecutionScope) {
  const location = resolvePackageCwd(scope);
  const manifest = readPackageManifest(scope, location);
  const scripts = manifest?.scripts ?? new Set<string>();
  const manager = manifest
    ? detectJavascriptPackageManager(scope, manifest)
    : 'npm';
  return Object.freeze({
    schemaVersion: 1 as const,
    sensors: Object.freeze([
      ...RECOMMENDED_PACKAGE_SENSOR_IDS.flatMap((id) =>
        scripts.has(RECOMMENDED_PACKAGE_SENSOR_SCRIPTS[id])
          ? [defaultPackageSensor(id, manager)]
          : [],
      ),
      DESIGN_SYSTEM_SENSOR,
    ]),
  });
}

function expectedPackageSensorIds(
  scope: ProjectExecutionScope,
  sensors: readonly SensorDefinition[],
): ReadonlySet<RecommendedPackageSensorId> {
  const manifests = new Map<string, PackageManifestCapabilities>();
  const candidates = [undefined, ...sensors.map((sensor) => sensor.cwd)];
  for (const cwd of candidates) {
    try {
      const location = resolvePackageCwd(scope, cwd);
      const manifest = readPackageManifest(scope, location);
      if (manifest) manifests.set(manifest.cwd, manifest);
    } catch {
      // Unsafe or unavailable cwd is not project capability.
    }
  }
  const expected = new Set<RecommendedPackageSensorId>();
  for (const manifest of manifests.values()) {
    for (const id of RECOMMENDED_PACKAGE_SENSOR_IDS) {
      if (manifest.scripts.has(RECOMMENDED_PACKAGE_SENSOR_SCRIPTS[id])) {
        expected.add(id);
      }
    }
  }
  return expected;
}

function designSystemSensorSourceCandidates(): string[] {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    candidates.push(path.join(process.resourcesPath, DESIGN_SYSTEM_SENSOR_SOURCE_NAME));
  }
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(
      path.resolve(
        path.dirname(here),
        `../../../scripts/${DESIGN_SYSTEM_SENSOR_SOURCE_NAME}`,
      ),
    );
  } catch {
    // import.meta.url may not be a file URL in some bundled environments.
  }
  return candidates;
}

function resolveDesignSystemSensorSourcePath(): string | undefined {
  for (const candidate of designSystemSensorSourceCandidates()) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.lstatSync(real).isFile()) return real;
    } catch {
      // Candidate unavailable; try the next one.
    }
  }
  return undefined;
}

/** Exact bundled bytes only; used by the finite context-commit allowlist. */
export function isExactBundledDesignSystemSensor(
  scope: ProjectExecutionScope,
): boolean {
  const source = resolveDesignSystemSensorSourcePath();
  if (!source) return false;
  const target = path.join(
    scope.rootRealPath,
    BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET,
  );
  try {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) return false;
    return fs.readFileSync(source).equals(fs.readFileSync(target));
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileExistsWithoutFollowing(scope: ProjectExecutionScope, relative: string): boolean {
  const absolute = path.join(scope.rootRealPath, relative);
  try {
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseConfig<T>(
  scope: ProjectExecutionScope,
  relative: string,
  schema: z.ZodType<T>,
): { data?: T; hash?: string; error?: string } {
  try {
    const content = readWorkspaceTextFile(scope, relative).content;
    const raw: unknown = JSON.parse(content);
    const result = schema.safeParse(raw);
    if (!result.success) return { error: result.error.message };
    return { data: result.data, hash: sha256(canonicalJson(result.data)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadContextConfiguration(
  scope: ProjectExecutionScope,
): LoadedContextConfiguration {
  const policy = parseConfig(scope, POLICY_PATH, policySchema);
  if (!policy.data || !policy.hash) {
    throw new Error(`invalid context policy: ${policy.error ?? 'missing policy'}`);
  }
  const sensors = parseConfig(scope, SENSORS_PATH, sensorsSchema);
  if (!sensors.data || !sensors.hash) {
    throw new Error(`invalid context sensors: ${sensors.error ?? 'missing sensors'}`);
  }
  return Object.freeze({
    policyHash: policy.hash,
    sensorConfigHash: sensors.hash,
    sensors: Object.freeze(
      sensors.data.sensors.map((sensor) => Object.freeze({
        ...sensor,
        command: Object.freeze([...sensor.command]),
      })),
    ),
  });
}

function addMissingDocs(
  blockers: ContextReadinessDiagnostic[],
  scope: ProjectExecutionScope,
): void {
  const missingBusiness = REQUIRED_BUSINESS_DOCS.filter(
    (relative) => !fileExistsWithoutFollowing(scope, relative),
  );
  if (missingBusiness.length > 0) {
    blockers.push(Object.freeze({
      code: 'missing-business-context',
      message: 'Contexto de negócio obrigatório não foi documentado por uma fonte versionada.',
      details: Object.freeze([...missingBusiness]),
    }));
  }
  const missingTechnical = REQUIRED_TECHNICAL_DOCS.filter(
    (relative) => !fileExistsWithoutFollowing(scope, relative),
  );
  if (missingTechnical.length > 0) {
    blockers.push(Object.freeze({
      code: 'missing-technical-context',
      message: 'Arquitetura e estratégia de testes precisam estar documentadas.',
      details: Object.freeze([...missingTechnical]),
    }));
  }
}

export function ensureContextScaffold(
  scope: ProjectExecutionScope,
): ContextScaffoldResult {
  const created: string[] = [];
  for (const relative of [
    '.context/docs',
    '.context/decisions',
    '.context/plans',
    '.context/agents',
    '.context/skills',
    '.context/nexus/facts',
    '.context/nexus/invariants',
    '.context/nexus/regressions',
    '.context/nexus/attestations',
    '.context/nexus/evidence',
    DESIGN_SYSTEM_SENSOR_TARGET_DIR,
  ]) {
    ensureWorkspaceDirectory(scope, relative);
  }

  // Copy the bundled design-system sensor into the workspace so the command in
  // sensors.json is portable and does not depend on the app install path.
  const sensorSource = resolveDesignSystemSensorSourcePath();
  if (sensorSource) {
    const sensorTargetAbsolute = path.join(
      scope.rootRealPath,
      BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET,
    );
    try {
      fs.copyFileSync(
        sensorSource,
        sensorTargetAbsolute,
        fs.constants.COPYFILE_EXCL,
      );
      created.push(BUNDLED_DESIGN_SYSTEM_SENSOR_TARGET);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Best-effort: the sensor command will fail clearly if unavailable.
      }
    }
  }

  for (const [relative, value] of [
    [POLICY_PATH, DEFAULT_POLICY],
    [SENSORS_PATH, defaultSensorsForScope(scope)],
  ] as const) {
    if (fileExistsWithoutFollowing(scope, relative)) continue;
    const result = writeWorkspaceTextFile(
      scope,
      relative,
      `${JSON.stringify(value, null, 2)}\n`,
    );
    if (!result.existed) created.push(relative);
  }
  return Object.freeze({ created: Object.freeze(created.sort()) });
}

/** Names target + attestation: shared sources otherwise look duplicated. */
function attestationDetail(item: ContextAttestationDiagnostic): string {
  const where = [item.targetPath, item.attestationPath?.split('/').pop()]
    .filter(Boolean)
    .join(' via ');
  return where ? `${item.message} (${where})` : item.message;
}

export function inspectContextReadiness(
  scope: ProjectExecutionScope,
  options: ContextReadinessOptions,
): ContextReadinessReport {
  const blockers: ContextReadinessDiagnostic[] = [];
  const warnings: ContextReadinessDiagnostic[] = [];
  addMissingDocs(blockers, scope);

  const hasPolicy = fileExistsWithoutFollowing(scope, POLICY_PATH);
  const policy = hasPolicy
    ? parseConfig(scope, POLICY_PATH, policySchema)
    : undefined;
  if (!hasPolicy) {
    blockers.push({ code: 'missing-policy', message: 'Política de execução não encontrada.' });
  } else if (policy?.error) {
    blockers.push({ code: 'invalid-policy', message: 'Política inválida; não haverá fallback permissivo.', details: [policy.error] });
  }

  const hasSensors = fileExistsWithoutFollowing(scope, SENSORS_PATH);
  const sensors = hasSensors
    ? parseConfig(scope, SENSORS_PATH, sensorsSchema)
    : undefined;
  let sensorIds: string[] = [];
  if (!hasSensors) {
    blockers.push({ code: 'missing-sensors', message: 'Configuração declarativa de sensores não encontrada.' });
  } else if (sensors?.error) {
    blockers.push({ code: 'invalid-sensors', message: 'Configuração de sensores inválida.', details: [sensors.error] });
  } else if (sensors?.data) {
    sensorIds = applicableContextSensors(scope, sensors.data.sensors)
      .map((sensor) => sensor.id)
      .sort();
    const missing = CORE_PACKAGE_SENSOR_IDS.filter(
      (id) => !sensorIds.includes(id),
    );
    const expected = expectedPackageSensorIds(
      scope,
      sensors.data.sensors,
    );
    const missingExpected = missing.filter((id) => expected.has(id));
    const missingOptional = missing.filter((id) => !expected.has(id));
    if (missingExpected.length > 0) {
      blockers.push({
        code: 'missing-required-sensors',
        message:
          'O projeto declara scripts de validação sem sensores aplicáveis e canônicos.',
        details: missingExpected,
      });
    }
    if (missingOptional.length > 0) {
      // A stack que não expõe esses scripts não deve ser forçada a adotá-los.
      // Quando o script nasce depois do scaffold, porém, o ramo acima bloqueia
      // o freeze até a configuração versionada ser reconciliada.
      warnings.push({
        code: 'missing-required-sensors',
        message:
          'Sensores recomendados ausentes porque a stack não expõe esses scripts.',
        details: missingOptional,
      });
    }
    const missingQuality = QUALITY_PACKAGE_SENSOR_IDS.filter(
      (id) => !sensorIds.includes(id),
    );
    const expectedQuality = expectedPackageSensorIds(
      scope,
      sensors.data.sensors,
    );
    const missingExpectedQuality = missingQuality.filter((id) =>
      expectedQuality.has(id),
    );
    const missingUnavailableQuality = missingQuality.filter(
      (id) => !expectedQuality.has(id),
    );
    if (missingExpectedQuality.length > 0) {
      warnings.push({
        code: 'missing-quality-sensors',
        message:
          'O projeto expõe checks de qualidade sênior sem sensores canônicos configurados.',
        details: missingExpectedQuality,
      });
    }
    if (missingUnavailableQuality.length > 0) {
      warnings.push({
        code: 'missing-quality-sensors',
        message:
          'Checks de qualidade sênior permanecem advisory porque a stack não expõe comandos compatíveis.',
        details: missingUnavailableQuality,
      });
    }
  }

  let corpusRevision: string | undefined;
  const attestationInspection = inspectContextAttestations(scope);
  const attestationDiagnostics = partitionAttestationDiagnostics(
    attestationInspection.diagnostics,
  );
  if (attestationDiagnostics.blocking.length > 0) {
    blockers.push({
      code: 'invalid-context-attestation',
      message: 'Uma autoridade de contexto perdeu o vínculo com suas fontes revisadas.',
      details: attestationDiagnostics.blocking.map(attestationDetail),
    });
  }
  if (attestationDiagnostics.sourceDrift.length > 0) {
    warnings.push({
      code: 'invalid-context-attestation',
      message: 'A fonte revisada mudou, mas o conteúdo do alvo permanece idêntico.',
      details: attestationDiagnostics.sourceDrift.map(attestationDetail),
    });
  }
  if (attestationDiagnostics.quarantined.length > 0) {
    warnings.push({
      code: 'invalid-context-attestation',
      message:
        'Uma attestation ilegível foi ignorada (quarentena). Remova ou regenere o arquivo.',
      details: attestationDiagnostics.quarantined.map(attestationDetail),
    });
  }
  try {
    const corpus = ingestProjectContext(scope);
    corpusRevision = corpus.contextRevision;
    const invariants = corpus.facts.filter(
      (fact) => fact.category === 'invariant' &&
        (fact.kind === 'asserted' || fact.kind === 'observed'),
    );
    if (invariants.length === 0) {
      blockers.push({
        code: 'missing-structured-invariants',
        message: 'Ao menos uma invariante estruturada e com proveniência é obrigatória.',
      });
    }
    const reviewedTargets = new Set(
      [
        ...attestationInspection.attestations.map(
          (attestation) => attestation.targetPath,
        ),
        ...attestationDiagnostics.sourceDriftTargets,
      ],
    );
    const authorityTargets = new Set<string>([
      ...REQUIRED_BUSINESS_DOCS.filter((relative) => fileExistsWithoutFollowing(scope, relative)),
      ...REQUIRED_TECHNICAL_DOCS.filter((relative) => fileExistsWithoutFollowing(scope, relative)),
      ...authorityFactLocators(corpus.facts),
    ]);
    const missingAttestations = [...authorityTargets]
      .filter((relative) => !reviewedTargets.has(relative))
      .sort();
    if (missingAttestations.length > 0) {
      blockers.push({
        code: 'missing-context-attestation',
        message: 'Documentos e fatos só se tornam autoridade após revisão independente vinculada às fontes.',
        details: missingAttestations,
      });
    }
    const conflicts = detectContextConflicts({
      facts: corpus.facts,
      requiredFactIds: options.requiredFactIds ?? invariants.map((fact) => fact.id),
      knownSymbols: options.knownSymbols,
      impactedDomains: options.impactedDomains ?? [],
    });
    for (const conflict of conflicts) {
      const diagnostic = Object.freeze({
        code: 'context-conflict' as const,
        message: `${conflict.kind}: ${conflict.claims.join('; ')}`,
        details: Object.freeze([conflict.id]),
      });
      if (conflict.severity === 'blocking') blockers.push(diagnostic);
      else warnings.push(diagnostic);
    }
  } catch (error) {
    blockers.push({
      code: 'invalid-context',
      message: 'O corpus de contexto não pôde ser validado.',
      details: [error instanceof Error ? error.message : String(error)],
    });
  }

  const contextRevision = corpusRevision && policy?.hash && sensors?.hash
    ? sha256(canonicalJson({
      corpusRevision,
      attestationHash: attestationInspection.bindingHash,
      policyHash: policy.hash,
      sensorsHash: sensors.hash,
    }))
    : undefined;
  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze([...blockers]),
    warnings: Object.freeze([...warnings]),
    contextRevision,
    sensorIds: Object.freeze(sensorIds),
  });
}
