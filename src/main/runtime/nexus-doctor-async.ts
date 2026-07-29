import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_MANIFEST_VERSION,
  legacyProjectManifestSchema,
  projectManifestSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  collectGitRepositoryProofAsync,
  compareRepositoryLineage,
  isGitCommitReachableAsync,
} from '../persistence/project-git-lineage';
import { inspectContextDoctor } from './nexus-doctor-context-check';
import {
  inspectIndependentProviders,
  inspectMultiPcBackend,
  inspectSandboxCapabilityAsync,
} from './nexus-doctor-capability-checks';
import {
  AsyncProcessGitRunner,
  assertSafeLocalGitConfigAsync,
  type AsyncGitRunner,
} from './git-command';
import {
  collectRemediation,
  inspectSqliteRuntime,
  type ContextDoctorSnapshot,
  type IndependentProviderSnapshot,
  type NexusDoctorCheckResult,
  type NexusDoctorFinding,
  type NexusDoctorOptions,
  type NexusDoctorReport,
} from './nexus-doctor';
import {
  doctorCheckResult as checkResult,
  doctorErrorMessage as errorMessage,
  doctorFinding as finding,
} from './nexus-doctor-support';
import { inspectSensorsAsync } from './nexus-doctor-sensor-check';

const DEFAULT_REQUIRED_SENSORS = Object.freeze(['typecheck', 'unit'] as const);
const DEFAULT_MIN_INDEPENDENT = 3;
const PROJECT_MANIFEST_REL = '.nexus/project.json';
const DOCTOR_GIT_TIMEOUT_MS = 5_000;

async function inspectGit(
  scope: ProjectExecutionScope,
  git: AsyncGitRunner,
): Promise<NexusDoctorFinding[]> {
  const findings: NexusDoctorFinding[] = [];
  try {
    const inside = await git.run(
      scope.rootRealPath,
      ['rev-parse', '--is-inside-work-tree'],
      { allowFailure: true },
    );
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
      return [finding(
        'git',
        'blocker',
        'not-a-git-repository',
        'O workspace não é um repositório Git válido.',
        'Inicialize ou clone o repositório Git do projeto e reabra o workspace no Nexus.',
        [inside.stderr.trim() || inside.stdout.trim()].filter(Boolean),
      )];
    }
  } catch (error) {
    return [finding(
      'git',
      'blocker',
      'git-unavailable',
      'Git não está disponível ou falhou ao inspecionar o workspace.',
      'Instale o Git, garanta que o binário está no PATH e que o workspace é legível.',
      [errorMessage(error)],
    )];
  }
  try {
    await assertSafeLocalGitConfigAsync(git, scope.rootRealPath);
  } catch (error) {
    findings.push(finding(
      'git',
      'blocker',
      'unsafe-git-config',
      'Configuração Git local executável bloqueia o runtime fail-closed.',
      'Remova hooksPath/fsmonitor/filters/diff/merge drivers do .git/config local ou limpe o repositório.',
      [errorMessage(error)],
    ));
  }
  try {
    const dirty = await git.run(
      scope.rootRealPath,
      ['status', '--porcelain'],
      { allowFailure: true },
    );
    if (dirty.status === 0 && dirty.stdout.trim().length > 0) {
      findings.push(finding(
        'git',
        'warning',
        'dirty-worktree',
        'O worktree principal tem alterações não commitadas.',
        'Faça commit ou stash antes de missões com sensores e merge queue, ou use worktrees isolados.',
      ));
    }
  } catch {
    // Status is advisory; availability was already checked.
  }
  return findings;
}

async function inspectProjectManifest(
  scope: ProjectExecutionScope,
  git: AsyncGitRunner,
): Promise<NexusDoctorFinding[]> {
  const findings: NexusDoctorFinding[] = [];
  const manifestPath = path.join(scope.rootRealPath, PROJECT_MANIFEST_REL);
  try {
    await fs.promises.access(manifestPath, fs.constants.F_OK);
  } catch {
    return [finding(
      'project-manifest',
      'warning',
      'missing-project-manifest',
      'Arquivo .nexus/project.json ausente; identidade multi-PC fica provisória (não bloqueia missões nem o freeze de contrato).',
      `Opcional, para identidade portátil entre máquinas: gere .nexus/project.json com schemaVersion ${PROJECT_MANIFEST_VERSION}, projectId UUID e prova de origin/linhagem Git.`,
    )];
  }
  try {
    const stat = await fs.promises.lstat(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      return [finding(
        'project-manifest',
        'blocker',
        'unsafe-project-manifest',
        '.nexus/project.json precisa ser um arquivo regular, sem symlink ou hardlink.',
        'Substitua .nexus/project.json por um arquivo regular versionado dentro do checkout.',
      )];
    }
    const raw: unknown = JSON.parse(
      await fs.promises.readFile(manifestPath, 'utf8'),
    );
    const legacy = legacyProjectManifestSchema.safeParse(raw);
    if (legacy.success) {
      return [finding(
        'project-manifest',
        'blocker',
        'legacy-project-manifest-unverified',
        'Manifesto v1 não contém prova portátil de origem/linhagem e está em quarentena.',
        `Confirme o repositório e regenere .nexus/project.json no schemaVersion ${PROJECT_MANIFEST_VERSION}; não reutilize projectId legado sem verificação.`,
      )];
    }
    const parsed = projectManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return [finding(
        'project-manifest',
        'blocker',
        'invalid-project-manifest',
        'Manifesto .nexus/project.json inválido.',
        `Corrija schemaVersion (${PROJECT_MANIFEST_VERSION}), projectId (UUID) e repository lineage segundo o schema portátil.`,
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`,
        ),
      )];
    }
    try {
      const proof = await collectGitRepositoryProofAsync(
        scope.rootRealPath,
        git,
      );
      const reachable = new Set<string>();
      await Promise.all(
        parsed.data.repository.anchorCommits.map(async (commit) => {
          if (
            await isGitCommitReachableAsync(scope.rootRealPath, commit, git)
          ) {
            reachable.add(commit);
          }
        }),
      );
      const compatibility = compareRepositoryLineage(
        parsed.data.repository,
        proof,
        (commit) => reachable.has(commit),
      );
      if (!compatibility.ok) {
        return [finding(
          'project-manifest',
          'blocker',
          compatibility.reason === 'mismatch'
            ? 'project-lineage-mismatch'
            : 'project-lineage-unverifiable',
          `Manifesto está em quarentena: ${compatibility.detail}.`,
          'Abra o clone correto ou regenere .nexus/project.json somente após confirmar origin/histórico; clones shallow precisam de origin portátil.',
        )];
      }
    } catch (error) {
      return [finding(
        'project-manifest',
        'blocker',
        'project-lineage-unverifiable',
        'Não foi possível verificar a linhagem Git do manifesto.',
        'Corrija o repositório Git e confirme origin/histórico antes de regenerar .nexus/project.json.',
        [errorMessage(error)],
      )];
    }
    if (
      scope.identitySource === 'manifest' &&
      parsed.data.projectId !== scope.projectId
    ) {
      findings.push(finding(
        'project-manifest',
        'blocker',
        'project-id-mismatch',
        'projectId do manifesto diverge do ProjectExecutionScope ativo.',
        'Reabra o projeto para re-resolver o escopo ou alinhe projectId no manifesto e no scope.',
        [parsed.data.projectId, scope.projectId],
      ));
    }
  } catch (error) {
    findings.push(finding(
      'project-manifest',
      'blocker',
      'project-manifest-unreadable',
      'Não foi possível ler .nexus/project.json.',
      'Verifique permissões de leitura e JSON válido em .nexus/project.json.',
      [errorMessage(error)],
    ));
  }
  return findings;
}

async function inspectFilesystemPermissions(
  scope: ProjectExecutionScope,
): Promise<NexusDoctorFinding[]> {
  const findings: NexusDoctorFinding[] = [];
  const root = scope.rootRealPath;
  try {
    await fs.promises.access(root, fs.constants.F_OK);
  } catch {
    return [finding(
      'filesystem-permissions',
      'blocker',
      'workspace-missing',
      'rootRealPath do scope não existe no filesystem.',
      'Reabra o workspace a partir de um diretório existente e resolva o ProjectExecutionScope novamente.',
      [root],
    )];
  }
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) {
      return [finding(
        'filesystem-permissions',
        'blocker',
        'workspace-not-directory',
        'rootRealPath não é um diretório.',
        'Aponte o scope para a raiz real do checkout do projeto.',
        [root],
      )];
    }
  } catch (error) {
    return [finding(
      'filesystem-permissions',
      'blocker',
      'workspace-unstatable',
      'Não foi possível fazer stat do workspace.',
      'Verifique permissões POSIX/ACL no diretório do projeto.',
      [errorMessage(error)],
    )];
  }
  for (const [mode, code, message, remediation] of [
    [
      fs.constants.R_OK,
      'workspace-not-readable',
      'Workspace sem permissão de leitura.',
      'Ajuste ownership/chmod para o usuário que executa o Nexus ler o checkout.',
    ],
    [
      fs.constants.W_OK,
      'workspace-not-writable',
      'Workspace sem permissão de escrita (worktrees/sensores locais podem falhar).',
      'Garanta escrita no checkout ou use um runtime worktree em volume gravável.',
    ],
  ] as const) {
    try {
      await fs.promises.access(root, mode);
    } catch (error) {
      findings.push(finding(
        'filesystem-permissions',
        'blocker',
        code,
        message,
        remediation,
        [errorMessage(error)],
      ));
    }
  }
  const nexusDir = path.join(root, '.nexus');
  try {
    await fs.promises.access(nexusDir, fs.constants.F_OK);
    await fs.promises.access(nexusDir, fs.constants.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      findings.push(finding(
        'filesystem-permissions',
        'blocker',
        'nexus-dir-not-readable',
        'Diretório .nexus/ existe mas não é legível.',
        'Corrija permissões de .nexus/ (idealmente 0o700 no diretório de máquina; manifesto versionado no repo).',
        [errorMessage(error)],
      ));
    }
  }
  return findings;
}

function asyncGitFor(options: NexusDoctorOptions): AsyncGitRunner {
  if (options.asyncGit) return options.asyncGit;
  if (options.git) {
    return {
      run: async (cwd, args, runOptions) =>
        options.git!.run(cwd, args, runOptions),
    };
  }
  const runner = new AsyncProcessGitRunner();
  return {
    run: (cwd, args, runOptions) =>
      runner.run(cwd, args, {
        ...runOptions,
        timeoutMs: Math.min(
          runOptions?.timeoutMs ?? DOCTOR_GIT_TIMEOUT_MS,
          DOCTOR_GIT_TIMEOUT_MS,
        ),
      }),
  };
}

/** Production operational Doctor used by the Electron main process. */
export async function inspectNexusReadinessAsync(
  options: NexusDoctorOptions,
): Promise<NexusDoctorReport> {
  const scope = Object.freeze({ ...options.scope });
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const git = asyncGitFor(options);
  const minIndependent =
    options.minIndependentProviders ?? DEFAULT_MIN_INDEPENDENT;
  if (
    !Number.isSafeInteger(minIndependent) ||
    minIndependent < 2 ||
    minIndependent > 16
  ) {
    throw new Error('invalid independent provider quorum');
  }
  const requiredSensors =
    options.requiredSensorIds ?? DEFAULT_REQUIRED_SENSORS;
  let contextSnapshot: ContextDoctorSnapshot | undefined;
  let contextProbeError: unknown;
  if (options.inspectContext) {
    try {
      contextSnapshot = options.inspectContext(scope);
    } catch (error) {
      contextProbeError = error;
    }
  }
  let providerSnapshot: readonly IndependentProviderSnapshot[] | undefined;
  try {
    providerSnapshot = options.listProviders?.();
  } catch {
    providerSnapshot = undefined;
  }
  const pathExecutable =
    options.pathExecutable ??
    options.pathExists ??
    (async (candidate: string) => {
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const fileExists = async (candidate: string): Promise<boolean> => {
    try {
      await fs.promises.access(candidate, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  const [
    gitFindings,
    manifestFindings,
    sensorFindings,
    sandboxFindings,
    filesystemFindings,
  ] = await Promise.all([
    inspectGit(scope, git),
    inspectProjectManifest(scope, git),
    inspectSensorsAsync(scope, {
      exists: fileExists,
      readFile: (candidate, encoding) =>
        fs.promises.readFile(candidate, encoding),
      requiredSensorIds: requiredSensors,
      contextSensorIds: contextSnapshot?.sensorIds,
    }),
    inspectSandboxCapabilityAsync(platform, pathExecutable),
    inspectFilesystemPermissions(scope),
  ]);
  const checks: NexusDoctorCheckResult[] = [
    checkResult('git', gitFindings),
    checkResult('project-manifest', manifestFindings),
    checkResult('sqlite-runtime', inspectSqliteRuntime(scope, options.runtime)),
    checkResult(
      'context-doctor',
      inspectContextDoctor(
        contextSnapshot,
        options.inspectContext !== undefined,
        contextProbeError,
      ),
    ),
    checkResult('sensors', sensorFindings),
    checkResult('sandbox', sandboxFindings),
    checkResult(
      'independent-providers',
      inspectIndependentProviders(providerSnapshot, minIndependent),
    ),
    checkResult('multi-pc-backend', inspectMultiPcBackend(options.multiPc)),
    checkResult('filesystem-permissions', filesystemFindings),
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
