import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  ensureWorkspaceDirectory,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from '../orch/workspace-file';
import { detectContextConflicts } from './ambiguity-engine';
import { canonicalJson } from './canonical-json';
import {
  inspectContextAttestations,
  type ContextAttestationDiagnostic,
} from './context-attestation';
import { ingestProjectContext } from './context-ingestor';
import type { SensorDefinition } from './sensor-broker';

const POLICY_PATH = '.context/config/policy.json';
const SENSORS_PATH = '.context/config/sensors.json';
const DESIGN_SYSTEM_SENSOR_SOURCE_NAME = 'design-system-sensor.mjs';
const DESIGN_SYSTEM_SENSOR_TARGET_DIR = '.context/nexus/sensors';
const DESIGN_SYSTEM_SENSOR_TARGET = `${DESIGN_SYSTEM_SENSOR_TARGET_DIR}/${DESIGN_SYSTEM_SENSOR_SOURCE_NAME}`;
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
        requireDifferentProviderFor: z.array(riskSchema).min(1).max(4),
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
    if (!policy.review.requireDifferentProviderFor.includes('high') ||
        !policy.review.requireDifferentProviderFor.includes('critical')) {
      context.addIssue({ code: 'custom', message: 'high and critical reviews require another provider' });
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
    requireDifferentProviderFor: Object.freeze(['high', 'critical']),
    minimumReviewers: Object.freeze({ high: 1, critical: 2 }),
  }),
});

const DEFAULT_SENSORS = Object.freeze({
  schemaVersion: 1,
  sensors: Object.freeze([
    Object.freeze({
      id: 'typecheck',
      command: Object.freeze(['npm', 'run', 'typecheck']),
      timeoutMs: 15 * 60_000,
      network: false,
    }),
    Object.freeze({
      id: 'unit',
      command: Object.freeze(['npm', 'test', '--', '--run']),
      timeoutMs: 15 * 60_000,
      network: false,
    }),
    Object.freeze({
      id: 'design-system',
      command: Object.freeze(['node', DESIGN_SYSTEM_SENSOR_TARGET]),
      timeoutMs: 60_000,
      network: false,
    }),
  ]),
});

function designSystemSensorSourceCandidates(): string[] {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    candidates.push(path.join(process.resourcesPath, DESIGN_SYSTEM_SENSOR_SOURCE_NAME));
  }
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(path.resolve(here, `../../../scripts/${DESIGN_SYSTEM_SENSOR_SOURCE_NAME}`));
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

function partitionAttestationDiagnostics(
  diagnostics: readonly ContextAttestationDiagnostic[],
): {
  readonly blocking: readonly ContextAttestationDiagnostic[];
  readonly sourceDrift: readonly ContextAttestationDiagnostic[];
  readonly sourceDriftTargets: ReadonlySet<string>;
} {
  const byPath = new Map<string, ContextAttestationDiagnostic[]>();
  const blocking = diagnostics.filter((item) => {
    if (!item.attestationPath) return true;
    const group = byPath.get(item.attestationPath) ?? [];
    group.push(item);
    byPath.set(item.attestationPath, group);
    return false;
  });
  const sourceDrift: ContextAttestationDiagnostic[] = [];
  const sourceDriftTargets = new Set<string>();
  for (const group of byPath.values()) {
    const isSourceDriftOnly = group.every(
      (item) => item.code === 'source-hash-mismatch' && item.targetPath,
    );
    if (!isSourceDriftOnly) {
      blocking.push(...group);
      continue;
    }
    sourceDrift.push(...group);
    for (const item of group) sourceDriftTargets.add(item.targetPath!);
  }
  return { blocking, sourceDrift, sourceDriftTargets };
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
    const sensorTargetAbsolute = path.join(scope.rootRealPath, DESIGN_SYSTEM_SENSOR_TARGET);
    try {
      fs.copyFileSync(sensorSource, sensorTargetAbsolute);
    } catch {
      // Best-effort: the sensor command will fail clearly if the file is missing.
    }
  }

  for (const [relative, value] of [
    [POLICY_PATH, DEFAULT_POLICY],
    [SENSORS_PATH, DEFAULT_SENSORS],
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
    sensorIds = sensors.data.sensors.map((sensor) => sensor.id).sort();
    const missing = ['typecheck', 'unit'].filter((id) => !sensorIds.includes(id));
    if (missing.length > 0) {
      // WARNING, não blocker (caso de campo 17/07: "toda hora um limite
      // diferente"): exigir typecheck E unit trancava o freeze de qualquer
      // projeto sem exatamente esses dois sensores — e sem freeze, TUDO trava.
      // Os sensores que existirem seguem rodando no PREVC; o que falta é
      // recomendado, não obrigatório. Não afeta o contextRevision (o hash usa
      // o arquivo de sensores como está).
      warnings.push({ code: 'missing-required-sensors', message: 'Sensores recomendados ausentes (typecheck/unit) — os configurados seguem valendo.', details: missing });
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
      details: attestationDiagnostics.blocking.map((item) => item.message),
    });
  }
  if (attestationDiagnostics.sourceDrift.length > 0) {
    warnings.push({
      code: 'invalid-context-attestation',
      message: 'A fonte revisada mudou, mas o conteúdo do alvo permanece idêntico.',
      details: attestationDiagnostics.sourceDrift.map((item) => item.message),
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
      ...corpus.facts.map((fact) => fact.source.locator),
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
