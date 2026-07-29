import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_MANIFEST_VERSION,
  legacyProjectManifestSchema,
  projectManifestSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  collectGitRepositoryProof,
  compareRepositoryLineage,
  isGitCommitReachable,
} from '../persistence/project-git-lineage';
import {
  assertSafeLocalGitConfig,
  type AsyncGitRunner,
  ProcessGitRunner,
  type GitRunner,
} from './git-command';
import type { ProjectRuntimeHealth } from './project-runtime-manager';
import { inspectContextDoctor } from './nexus-doctor-context-check';
import {
  inspectIndependentProviders,
  inspectMultiPcBackend,
  inspectSandboxCapability,
  inspectSandboxCapabilityAsync,
} from './nexus-doctor-capability-checks';
import { inspectSensors } from './nexus-doctor-sensor-check';
import {
  doctorCheckResult as checkResult,
  doctorErrorMessage as errorMessage,
  doctorFinding as finding,
  doctorPathExists as exists,
} from './nexus-doctor-support';

export { inspectSandboxCapability, inspectSandboxCapabilityAsync };

/**
 * Distribution / environment Doctor for Nexus runtime readiness.
 *
 * Composes existing subsystem probes (Git, SQLite runtime, project manifest,
 * Context Doctor, sensors, sandbox providers, independent CLIs, multi-PC
 * backends, filesystem permissions) into one fail-closed report.
 *
 * Side-effect free aside from read-only inspection and optional temporary
 * runtime open via the injected ProjectRuntimeManager.
 */

export type NexusDoctorCheckId =
  | 'git'
  | 'project-manifest'
  | 'sqlite-runtime'
  | 'context-doctor'
  | 'sensors'
  | 'sandbox'
  | 'independent-providers'
  | 'multi-pc-backend'
  | 'filesystem-permissions';

export type NexusDoctorSeverity = 'blocker' | 'warning';

export interface NexusDoctorFinding {
  readonly check: NexusDoctorCheckId;
  readonly code: string;
  readonly message: string;
  readonly severity: NexusDoctorSeverity;
  readonly remediation: string;
  readonly details?: readonly string[];
}

export interface NexusDoctorCheckResult {
  readonly check: NexusDoctorCheckId;
  readonly ok: boolean;
  readonly findings: readonly NexusDoctorFinding[];
}

export interface NexusDoctorReport {
  readonly ready: boolean;
  readonly blockers: readonly NexusDoctorFinding[];
  readonly warnings: readonly NexusDoctorFinding[];
  /** Deduplicated remediation steps (blockers first, then warnings). */
  readonly remediation: readonly string[];
  readonly checks: readonly NexusDoctorCheckResult[];
  readonly checkedAt: number;
  readonly platform: NodeJS.Platform;
  readonly scope: ProjectExecutionScope;
}

export interface ContextDoctorSnapshot {
  readonly ready: boolean;
  readonly blockers: readonly {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly string[];
  }[];
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly string[];
  }[];
  readonly sensorIds: readonly string[];
}

export interface IndependentProviderSnapshot {
  readonly adapterId: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly kind: 'cli-pty' | 'api-provider';
  /** When present, login-needed providers do not count toward independent quorum. */
  readonly authStrategy?: 'subscription' | 'api-key' | 'login-needed' | string;
  /** True only when Nexus can enforce a read-only reviewer for this adapter. */
  readonly readOnlyCapable?: boolean;
}

export interface MultiPcBackendStatus {
  readonly leaseBackendConfigured: boolean;
  readonly syncBackendConfigured: boolean;
  /**
   * Missing backends block by default. Set false only for an explicitly
   * single-device installation where shared execution is not promised.
   */
  readonly requireSharedExecution?: boolean;
}

export interface RuntimeHealthProbe {
  openAndInspect(scope: ProjectExecutionScope): ProjectRuntimeHealth;
}

export interface NexusDoctorOptions {
  readonly scope: ProjectExecutionScope;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly git?: GitRunner;
  readonly asyncGit?: AsyncGitRunner;
  readonly runtime?: RuntimeHealthProbe | null;
  readonly inspectContext?: (scope: ProjectExecutionScope) => ContextDoctorSnapshot;
  readonly listProviders?: () => readonly IndependentProviderSnapshot[];
  readonly multiPc?: MultiPcBackendStatus;
  /** Minimum distinct installed+enabled CLI providers for independent review. */
  readonly minIndependentProviders?: number;
  readonly requiredSensorIds?: readonly string[];
  readonly fsAccess?: typeof fs.accessSync;
  readonly fsExists?: typeof fs.existsSync;
  readonly fsStat?: typeof fs.statSync;
  readonly fsLstat?: typeof fs.lstatSync;
  readonly fsReadFile?: typeof fs.readFileSync;
  readonly pathExists?: (candidate: string) => boolean;
  readonly pathExecutable?: (candidate: string) => boolean;
}

const DEFAULT_REQUIRED_SENSORS = Object.freeze(['typecheck', 'unit'] as const);
const DEFAULT_MIN_INDEPENDENT = 3;
const PROJECT_MANIFEST_REL = '.nexus/project.json';
function inspectGit(
  scope: ProjectExecutionScope,
  git: GitRunner,
): NexusDoctorFinding[] {
  const findings: NexusDoctorFinding[] = [];
  try {
    const inside = git.run(
      scope.rootRealPath,
      ['rev-parse', '--is-inside-work-tree'],
      { allowFailure: true },
    );
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
      findings.push(
        finding(
          'git',
          'blocker',
          'not-a-git-repository',
          'O workspace não é um repositório Git válido.',
          'Inicialize ou clone o repositório Git do projeto e reabra o workspace no Nexus.',
          [inside.stderr.trim() || inside.stdout.trim()].filter(Boolean),
        ),
      );
      return findings;
    }
  } catch (error) {
    findings.push(
      finding(
        'git',
        'blocker',
        'git-unavailable',
        'Git não está disponível ou falhou ao inspecionar o workspace.',
        'Instale o Git, garanta que o binário está no PATH e que o workspace é legível.',
        [errorMessage(error)],
      ),
    );
    return findings;
  }

  try {
    assertSafeLocalGitConfig(git, scope.rootRealPath);
  } catch (error) {
    findings.push(
      finding(
        'git',
        'blocker',
        'unsafe-git-config',
        'Configuração Git local executável bloqueia o runtime fail-closed.',
        'Remova hooksPath/fsmonitor/filters/diff/merge drivers do .git/config local ou limpe o repositório.',
        [errorMessage(error)],
      ),
    );
  }

  try {
    const dirty = git.run(
      scope.rootRealPath,
      ['status', '--porcelain'],
      { allowFailure: true },
    );
    if (dirty.status === 0 && dirty.stdout.trim().length > 0) {
      findings.push(
        finding(
          'git',
          'warning',
          'dirty-worktree',
          'O worktree principal tem alterações não commitadas.',
          'Faça commit ou stash antes de missões com sensores e merge queue, ou use worktrees isolados.',
        ),
      );
    }
  } catch {
    // Status is advisory; availability already verified above.
  }

  return findings;
}

function inspectProjectManifest(
  scope: ProjectExecutionScope,
  git: GitRunner,
  deps: {
    readonly exists: (c: string) => boolean;
    readonly readFile: typeof fs.readFileSync;
    readonly lstat: typeof fs.lstatSync;
  },
): NexusDoctorFinding[] {
  const findings: NexusDoctorFinding[] = [];
  const manifestPath = path.join(scope.rootRealPath, PROJECT_MANIFEST_REL);

  if (!deps.exists(manifestPath)) {
    findings.push(
      finding(
        'project-manifest',
        // Não é blocker: a identidade provisória (digest do caminho real) é
        // tolerada por todo o runtime — missões, freeze de contrato e stores
        // funcionam sem o manifest. Ele só importa para identidade portátil
        // multi-PC. Marcá-lo como blocker fazia missões/agentes tratarem um
        // arquivo opcional como pré-condição e travarem o bootstrap.
        'warning',
        'missing-project-manifest',
        'Arquivo .nexus/project.json ausente; identidade multi-PC fica provisória (não bloqueia missões nem o freeze de contrato).',
        `Opcional, para identidade portátil entre máquinas: gere .nexus/project.json com schemaVersion ${PROJECT_MANIFEST_VERSION}, projectId UUID e prova de origin/linhagem Git.`,
      ),
    );
    return findings;
  }

  try {
    const stat = deps.lstat(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      findings.push(
        finding(
          'project-manifest',
          'blocker',
          'unsafe-project-manifest',
          '.nexus/project.json precisa ser um arquivo regular, sem symlink ou hardlink.',
          'Substitua .nexus/project.json por um arquivo regular versionado dentro do checkout.',
        ),
      );
      return findings;
    }
    const raw: unknown = JSON.parse(deps.readFile(manifestPath, 'utf8'));
    const legacy = legacyProjectManifestSchema.safeParse(raw);
    if (legacy.success) {
      findings.push(
        finding(
          'project-manifest',
          'blocker',
          'legacy-project-manifest-unverified',
          'Manifesto v1 não contém prova portátil de origem/linhagem e está em quarentena.',
          `Confirme o repositório e regenere .nexus/project.json no schemaVersion ${PROJECT_MANIFEST_VERSION}; não reutilize projectId legado sem verificação.`,
        ),
      );
      return findings;
    }
    const parsed = projectManifestSchema.safeParse(raw);
    if (!parsed.success) {
      findings.push(
        finding(
          'project-manifest',
          'blocker',
          'invalid-project-manifest',
          'Manifesto .nexus/project.json inválido.',
          `Corrija schemaVersion (${PROJECT_MANIFEST_VERSION}), projectId (UUID) e repository lineage segundo o schema portátil.`,
          parsed.error.issues.map(
            (issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`,
          ),
        ),
      );
      return findings;
    }
    try {
      const proof = collectGitRepositoryProof(scope.rootRealPath, git);
      const compatibility = compareRepositoryLineage(
        parsed.data.repository,
        proof,
        (commit) => isGitCommitReachable(scope.rootRealPath, commit, git),
      );
      if (!compatibility.ok) {
        findings.push(
          finding(
            'project-manifest',
            'blocker',
            compatibility.reason === 'mismatch'
              ? 'project-lineage-mismatch'
              : 'project-lineage-unverifiable',
            `Manifesto está em quarentena: ${compatibility.detail}.`,
            'Abra o clone correto ou regenere .nexus/project.json somente após confirmar origin/histórico; clones shallow precisam de origin portátil.',
          ),
        );
        return findings;
      }
    } catch (error) {
      findings.push(
        finding(
          'project-manifest',
          'blocker',
          'project-lineage-unverifiable',
          'Não foi possível verificar a linhagem Git do manifesto.',
          'Corrija o repositório Git e confirme origin/histórico antes de regenerar .nexus/project.json.',
          [errorMessage(error)],
        ),
      );
      return findings;
    }
    if (
      scope.identitySource === 'manifest' &&
      parsed.data.projectId !== scope.projectId
    ) {
      findings.push(
        finding(
          'project-manifest',
          'blocker',
          'project-id-mismatch',
          'projectId do manifesto diverge do ProjectExecutionScope ativo.',
          'Reabra o projeto para re-resolver o escopo ou alinhe projectId no manifesto e no scope.',
          [parsed.data.projectId, scope.projectId],
        ),
      );
    }
    if (parsed.data.schemaVersion !== PROJECT_MANIFEST_VERSION) {
      findings.push(
        finding(
          'project-manifest',
          'blocker',
          'unsupported-manifest-version',
          `schemaVersion ${parsed.data.schemaVersion} não é suportado.`,
          `Atualize .nexus/project.json para schemaVersion ${PROJECT_MANIFEST_VERSION}.`,
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'project-manifest',
        'blocker',
        'project-manifest-unreadable',
        'Não foi possível ler .nexus/project.json.',
        'Verifique permissões de leitura e JSON válido em .nexus/project.json.',
        [errorMessage(error)],
      ),
    );
  }

  return findings;
}

export function inspectSqliteRuntime(
  scope: ProjectExecutionScope,
  runtime: RuntimeHealthProbe | null | undefined,
): NexusDoctorFinding[] {
  if (!runtime) {
    return [
      finding(
        'sqlite-runtime',
        'blocker',
        'runtime-probe-skipped',
        'ProjectRuntimeManager não foi injetado; SQLite por projeto não foi verificado.',
        'Passe um ProjectRuntimeManager (open + health) ao Nexus Doctor no bootstrap do main.',
      ),
    ];
  }

  try {
    const health = runtime.openAndInspect(scope);
    if (health.status === 'unavailable') {
      return [
        finding(
          'sqlite-runtime',
          'blocker',
          'runtime-unavailable',
          'Runtime SQLite do checkout está indisponível.',
          'Inspecione permissões do diretório de userData/projects, integrity check e logs de falha do runtime.',
          [
            health.failureCode ?? 'unknown',
            health.failureMessage ?? '',
            health.databasePath,
          ].filter(Boolean),
        ),
      ];
    }
    if (health.status === 'safe-read-only' || !health.writable) {
      return [
        finding(
          'sqlite-runtime',
          'blocker',
          'runtime-read-only',
          'Runtime SQLite abriu em safe-read-only; missões e stores não podem gravar.',
          'Corrija a falha de abertura/migração do runtime.db e remova locks ou corrupção antes de reabrir.',
          [
            health.failureCode ?? 'read-only',
            health.failureMessage ?? '',
            health.databasePath,
          ].filter(Boolean),
        ),
      ];
    }
    if (health.quickCheck.some((row) => row !== 'ok')) {
      return [
        finding(
          'sqlite-runtime',
          'blocker',
          'runtime-integrity-failed',
          'PRAGMA quick_check do runtime SQLite reportou falhas.',
          'Restaure o último backup do runtime ou recrie o checkout runtime após exportar dados críticos.',
          health.quickCheck.filter((row) => row !== 'ok'),
        ),
      ];
    }
    return [];
  } catch (error) {
    return [
      finding(
        'sqlite-runtime',
        'blocker',
        'runtime-open-failed',
        'Falha ao abrir o runtime SQLite por projeto/checkout.',
        'Verifique better-sqlite3, caminho userData e permissões do diretório de runtime.',
        [errorMessage(error)],
      ),
    ];
  }
}

function inspectFilesystemPermissions(
  scope: ProjectExecutionScope,
  deps: {
    readonly access: typeof fs.accessSync;
    readonly exists: (c: string) => boolean;
    readonly stat: typeof fs.statSync;
  },
): NexusDoctorFinding[] {
  const findings: NexusDoctorFinding[] = [];
  const root = scope.rootRealPath;

  if (!deps.exists(root)) {
    return [
      finding(
        'filesystem-permissions',
        'blocker',
        'workspace-missing',
        'rootRealPath do scope não existe no filesystem.',
        'Reabra o workspace a partir de um diretório existente e resolva o ProjectExecutionScope novamente.',
        [root],
      ),
    ];
  }

  try {
    const stat = deps.stat(root);
    if (!stat.isDirectory()) {
      return [
        finding(
          'filesystem-permissions',
          'blocker',
          'workspace-not-directory',
          'rootRealPath não é um diretório.',
          'Aponte o scope para a raiz real do checkout do projeto.',
          [root],
        ),
      ];
    }
  } catch (error) {
    return [
      finding(
        'filesystem-permissions',
        'blocker',
        'workspace-unstatable',
        'Não foi possível fazer stat do workspace.',
        'Verifique permissões POSIX/ACL no diretório do projeto.',
        [errorMessage(error)],
      ),
    ];
  }

  try {
    deps.access(root, fs.constants.R_OK);
  } catch (error) {
    findings.push(
      finding(
        'filesystem-permissions',
        'blocker',
        'workspace-not-readable',
        'Workspace sem permissão de leitura.',
        'Ajuste ownership/chmod para o usuário que executa o Nexus ler o checkout.',
        [errorMessage(error)],
      ),
    );
  }

  try {
    deps.access(root, fs.constants.W_OK);
  } catch (error) {
    findings.push(
      finding(
        'filesystem-permissions',
        'blocker',
        'workspace-not-writable',
        'Workspace sem permissão de escrita (worktrees/sensores locais podem falhar).',
        'Garanta escrita no checkout ou use um runtime worktree em volume gravável.',
        [errorMessage(error)],
      ),
    );
  }

  const nexusDir = path.join(root, '.nexus');
  if (deps.exists(nexusDir)) {
    try {
      deps.access(nexusDir, fs.constants.R_OK);
    } catch (error) {
      findings.push(
        finding(
          'filesystem-permissions',
          'blocker',
          'nexus-dir-not-readable',
          'Diretório .nexus/ existe mas não é legível.',
          'Corrija permissões de .nexus/ (idealmente 0o700 no diretório de máquina; manifesto versionado no repo).',
          [errorMessage(error)],
        ),
      );
    }
  }

  return findings;
}

export function collectRemediation(
  blockers: readonly NexusDoctorFinding[],
  warnings: readonly NexusDoctorFinding[],
): readonly string[] {
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const item of [...blockers, ...warnings]) {
    const step = item.remediation.trim();
    if (!step || seen.has(step)) continue;
    seen.add(step);
    steps.push(step);
  }
  return Object.freeze(steps);
}

/**
 * Run the full Nexus Doctor against a project execution scope.
 * Missing probes are blockers: this report is an execution gate, not a best-
 * effort diagnostics page. Tests inject pure probes without booting Electron.
 */
export function inspectNexusReadiness(
  options: NexusDoctorOptions,
): NexusDoctorReport {
  const scope = Object.freeze({ ...options.scope });
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const git = options.git ?? new ProcessGitRunner();
  const existsImpl = options.fsExists ?? fs.existsSync;
  const access = options.fsAccess ?? fs.accessSync;
  const pathExists = options.pathExists ?? existsImpl;
  const pathExecutable =
    options.pathExecutable ??
    options.pathExists ??
    ((candidate: string) => {
      try {
        access(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const existsFn = (candidate: string) => exists(pathExists, candidate);
  const readFile = options.fsReadFile ?? fs.readFileSync;
  const stat = options.fsStat ?? fs.statSync;
  const lstat = options.fsLstat ?? fs.lstatSync;
  const minIndependent = options.minIndependentProviders ?? DEFAULT_MIN_INDEPENDENT;
  if (!Number.isSafeInteger(minIndependent) || minIndependent < 2 || minIndependent > 16) {
    throw new Error('invalid independent provider quorum');
  }
  const requiredSensors = options.requiredSensorIds ?? DEFAULT_REQUIRED_SENSORS;

  let contextSnapshot: ContextDoctorSnapshot | undefined;
  let contextProbeError: unknown;
  if (options.inspectContext) {
    try {
      contextSnapshot = options.inspectContext(scope);
    } catch (error) {
      contextProbeError = error;
      contextSnapshot = undefined;
    }
  }
  let providerSnapshot: readonly IndependentProviderSnapshot[] | undefined;
  try {
    providerSnapshot = options.listProviders?.();
  } catch {
    providerSnapshot = undefined;
  }

  const checks: NexusDoctorCheckResult[] = [
    checkResult('git', inspectGit(scope, git)),
    checkResult(
      'project-manifest',
      inspectProjectManifest(scope, git, { exists: existsFn, readFile, lstat }),
    ),
    checkResult('sqlite-runtime', inspectSqliteRuntime(scope, options.runtime)),
    checkResult(
      'context-doctor',
      inspectContextDoctor(
        contextSnapshot,
        options.inspectContext !== undefined,
        contextProbeError,
      ),
    ),
    checkResult(
      'sensors',
      inspectSensors(scope, {
        exists: existsFn,
        readFile,
        requiredSensorIds: requiredSensors,
        contextSensorIds: contextSnapshot?.sensorIds,
      }),
    ),
    checkResult(
      'sandbox',
      inspectSandboxCapability(platform, pathExecutable),
    ),
    checkResult(
      'independent-providers',
      inspectIndependentProviders(providerSnapshot, minIndependent),
    ),
    checkResult('multi-pc-backend', inspectMultiPcBackend(options.multiPc)),
    checkResult(
      'filesystem-permissions',
      inspectFilesystemPermissions(scope, {
        access,
        exists: existsFn,
        stat,
      }),
    ),
  ];

  const allFindings = checks.flatMap((check) => check.findings);
  const blockers = Object.freeze(
    allFindings.filter((item) => item.severity === 'blocker'),
  );
  const warnings = Object.freeze(
    allFindings.filter((item) => item.severity === 'warning'),
  );

  return Object.freeze({
    ready: blockers.length === 0,
    blockers,
    warnings,
    remediation: collectRemediation(blockers, warnings),
    checks: Object.freeze(checks),
    checkedAt: now(),
    platform,
    scope,
  });
}

/**
 * Convenience: build a RuntimeHealthProbe from a ProjectRuntimeManager-like
 * object without importing the class at the call site for tests.
 */
export function runtimeHealthProbeFromManager(manager: {
  open(scope: ProjectExecutionScope): { health: ProjectRuntimeHealth; close?(): void };
  close?(scope: ProjectExecutionScope): boolean;
}): RuntimeHealthProbe {
  return {
    openAndInspect(scope) {
      const runtime = manager.open(scope);
      try {
        return runtime.health;
      } finally {
        // Prefer scope close so LRU/pins stay consistent when available.
        if (manager.close) {
          try {
            manager.close(scope);
          } catch {
            runtime.close?.();
          }
        } else {
          runtime.close?.();
        }
      }
    },
  };
}

export type ConfiguredNexusDoctor = (
  scope: ProjectExecutionScope,
) => NexusDoctorReport | Promise<NexusDoctorReport>;

let configuredDoctor: ConfiguredNexusDoctor | null = null;

export function configureNexusDoctor(
  inspector: ConfiguredNexusDoctor,
): void {
  configuredDoctor = inspector;
}

export async function inspectConfiguredNexusReadiness(
  scope: ProjectExecutionScope,
): Promise<NexusDoctorReport> {
  if (!configuredDoctor) throw new Error('Nexus Doctor is not initialized');
  return await configuredDoctor(scope);
}

export function disposeNexusDoctor(): void {
  configuredDoctor = null;
}
