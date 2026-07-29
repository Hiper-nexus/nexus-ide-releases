import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { GitResult, GitRunner } from './git-command';
import {
  configureNexusDoctor,
  disposeNexusDoctor,
  inspectConfiguredNexusReadiness,
  inspectNexusReadiness,
  inspectSandboxCapability,
  inspectSandboxCapabilityAsync,
  runtimeHealthProbeFromManager,
  type ContextDoctorSnapshot,
  type IndependentProviderSnapshot,
  type MultiPcBackendStatus,
} from './nexus-doctor';
import { inspectNexusReadinessAsync } from './nexus-doctor-async';
import type { ProjectRuntimeHealth } from './project-runtime-manager';

const roots: string[] = [];
const GIT_ROOT_COMMIT = '1'.repeat(40);

function manifestedProject(repositoryRoot = GIT_ROOT_COMMIT) {
  return {
    schemaVersion: 2,
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'fixture',
    repository: {
      vcs: 'git',
      originHashes: [],
      rootCommits: [repositoryRoot],
      anchorCommits: [repositoryRoot],
    },
  };
}

function scope(root: string, overrides: Partial<ProjectExecutionScope> = {}): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-test',
    projectId: '11111111-1111-4111-8111-111111111111',
    checkoutId: 'checkout-test',
    rootRealPath: root,
    identitySource: 'manifest' as const,
    ...overrides,
  });
}

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doctor-')));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, value: unknown): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function healthyRuntime(): ProjectRuntimeHealth {
  return Object.freeze({
    status: 'healthy',
    writable: true,
    databasePath: '/tmp/runtime.sqlite3',
    appVersion: 'test',
    schemaVersion: 1,
    quickCheck: Object.freeze(['ok']),
    lastBackupPath: null,
    failureCode: null,
    failureMessage: null,
    checkedAt: 1,
  });
}

function gitOk(dirty = false): GitRunner {
  return {
    run(_cwd, args): GitResult {
      const key = args.filter((arg) => arg !== '--no-replace-objects').join(' ');
      if (key === 'rev-parse --is-inside-work-tree') {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      if (key === 'rev-parse --is-shallow-repository') {
        return { status: 0, stdout: 'false\n', stderr: '' };
      }
      if (key === 'rev-list --max-parents=0 HEAD') {
        return { status: 0, stdout: `${GIT_ROOT_COMMIT}\n`, stderr: '' };
      }
      if (key === 'rev-parse HEAD') {
        return { status: 0, stdout: `${GIT_ROOT_COMMIT}\n`, stderr: '' };
      }
      if (key.startsWith('merge-base --is-ancestor ')) {
        const anchor = args[args.indexOf('--is-ancestor') + 1];
        return {
          status: anchor === GIT_ROOT_COMMIT ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      }
      if (key === 'config --local --no-includes --get-all remote.origin.url') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (key.startsWith('config --local --get-regexp')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (key === 'status --porcelain') {
        return {
          status: 0,
          stdout: dirty ? ' M README.md\n' : '',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function contextReady(sensorIds = ['typecheck', 'unit']): ContextDoctorSnapshot {
  return {
    ready: true,
    blockers: [],
    warnings: [],
    sensorIds,
  };
}

function criticalProviders(): IndependentProviderSnapshot[] {
  return [
    {
      adapterId: 'codex',
      enabled: true,
      installed: true,
      kind: 'cli-pty',
      authStrategy: 'subscription',
      readOnlyCapable: true,
    },
    {
      adapterId: 'claude',
      enabled: true,
      installed: true,
      kind: 'cli-pty',
      authStrategy: 'api-key',
      readOnlyCapable: true,
    },
    {
      adapterId: 'gemini',
      enabled: true,
      installed: true,
      kind: 'cli-pty',
      authStrategy: 'subscription',
      readOnlyCapable: true,
    },
  ];
}

function multiPcOk(): MultiPcBackendStatus {
  return {
    leaseBackendConfigured: true,
    syncBackendConfigured: true,
  };
}

function baseOptions(root: string) {
  write(root, '.nexus/project.json', manifestedProject());
  write(root, '.context/config/sensors.json', {
    schemaVersion: 1,
    sensors: [
      { id: 'typecheck', command: ['npm', 'run', 'typecheck'], timeoutMs: 60_000, network: false },
      { id: 'unit', command: ['npm', 'test'], timeoutMs: 60_000, network: false },
    ],
  });
  return {
    scope: scope(root),
    platform: 'darwin' as const,
    git: gitOk(),
    runtime: {
      openAndInspect: () => healthyRuntime(),
    },
    inspectContext: () => contextReady(),
    listProviders: () => criticalProviders(),
    multiPc: multiPcOk(),
    pathExists: (candidate: string) => {
      if (candidate === '/usr/bin/sandbox-exec') return true;
      try {
        fs.accessSync(candidate);
        return true;
      } catch {
        return false;
      }
    },
    now: () => 1_700_000_000_000,
  };
}

afterEach(() => {
  disposeNexusDoctor();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('inspectSandboxCapability', () => {
  it('accepts Seatbelt on darwin and Bubblewrap on linux', () => {
    expect(
      inspectSandboxCapability('darwin', (p) => p === '/usr/bin/sandbox-exec'),
    ).toEqual([]);
    expect(
      inspectSandboxCapability('linux', (p) => p === '/usr/bin/bwrap'),
    ).toEqual([]);
  });

  it('fails closed on Windows and missing linux provider', () => {
    const win = inspectSandboxCapability('win32', () => false);
    expect(win[0]).toMatchObject({
      check: 'sandbox',
      severity: 'blocker',
      code: 'sandbox-unavailable-windows',
    });
    expect(win[0].remediation.length).toBeGreaterThan(10);

    const linux = inspectSandboxCapability('linux', () => false);
    expect(linux[0]?.code).toBe('bubblewrap-unavailable');
  });

  it('accepts Windows only with an executable OCI runtime and digest-pinned image', () => {
    const runtime = 'C:\\Program Files\\Docker\\docker.exe';
    expect(inspectSandboxCapability(
      'win32',
      (candidate) => candidate === runtime,
      {
        NEXUS_SANDBOX_CONTAINER_RUNTIME: runtime,
        NEXUS_SANDBOX_CONTAINER_IMAGE: `registry.example/nexus-sensors@sha256:${'a'.repeat(64)}`,
      },
      () => true,
    )).toEqual([]);
  });

  it('awaits the Windows OCI probe without blocking another main-loop task', async () => {
    const runtime = 'C:\\Program Files\\Docker\\docker.exe';
    let releaseProbe: ((value: boolean) => void) | undefined;
    const pendingProbe = new Promise<boolean>((resolve) => {
      releaseProbe = resolve;
    });
    const pending = inspectSandboxCapabilityAsync(
      'win32',
      async (candidate) => candidate === runtime,
      {
        NEXUS_SANDBOX_CONTAINER_RUNTIME: runtime,
        NEXUS_SANDBOX_CONTAINER_IMAGE:
          `registry.example/nexus@sha256:${'a'.repeat(64)}`,
      },
      async () => pendingProbe,
    );

    await expect(
      new Promise<string>((resolve) => setImmediate(() => resolve('free'))),
    ).resolves.toBe('free');
    releaseProbe?.(true);
    await expect(pending).resolves.toEqual([]);
  });
});

describe('inspectNexusReadiness', () => {
  it('exposes only the main-process configured Doctor to native tools', async () => {
    const root = makeRoot();
    configureNexusDoctor((requestedScope) => inspectNexusReadiness({
      ...baseOptions(root),
      scope: requestedScope,
    }));

    await expect(
      inspectConfiguredNexusReadiness(scope(root)),
    ).resolves.toMatchObject({ ready: true });
    disposeNexusDoctor();
    await expect(
      inspectConfiguredNexusReadiness(scope(root)),
    ).rejects.toThrow(/not initialized/i);
  });

  it('is ready when all probes pass and returns structured remediation empty', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness(baseOptions(root));

    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.remediation).toEqual([]);
    expect(report.platform).toBe('darwin');
    expect(report.checkedAt).toBe(1_700_000_000_000);
    expect(report.checks).toHaveLength(9);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it('uses the asynchronous Git/FS/sandbox path for configured diagnostics', async () => {
    const root = makeRoot();
    const syncGit = {
      run: () => {
        throw new Error('sync Git must not run');
      },
    };
    const asyncGitSource = gitOk();
    const report = await inspectNexusReadinessAsync({
      ...baseOptions(root),
      git: syncGit,
      asyncGit: {
        run: async (cwd, args, options) => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return asyncGitSource.run(cwd, args, options);
        },
      },
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toHaveLength(9);
  });

  it('reports concrete blockers with remediation for git, manifest, sensors and providers', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness({
      scope: scope(root),
      platform: 'darwin',
      git: {
        run: () => {
          throw new Error('git missing');
        },
      },
      runtime: {
        openAndInspect: () => ({
          ...healthyRuntime(),
          status: 'unavailable',
          writable: false,
          failureCode: 'database_open_failed',
          failureMessage: 'locked',
        }),
      },
      inspectContext: () => ({
        ready: false,
        blockers: [
          {
            code: 'missing-business-context',
            message: 'business docs missing',
            details: ['.context/docs/business-model.md'],
          },
        ],
        warnings: [],
        sensorIds: [],
      }),
      listProviders: () => [
        {
          adapterId: 'codex',
          enabled: true,
          installed: true,
          kind: 'cli-pty',
          authStrategy: 'subscription',
          readOnlyCapable: true,
        },
      ],
      multiPc: {
        leaseBackendConfigured: false,
        syncBackendConfigured: false,
        requireSharedExecution: true,
      },
      pathExists: (candidate) => candidate === '/usr/bin/sandbox-exec',
    });

    expect(report.ready).toBe(false);
    const codes = report.blockers.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'git-unavailable',
        'runtime-unavailable',
        'missing-business-context',
        'missing-sensors-config',
        'lease-backend-unconfigured',
      ]),
    );
    // Manifest ausente é provisório; um único provider, porém, não consegue
    // separar autor e reviewer entre vendors e permanece blocker.
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-project-manifest' }),
    );
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: 'insufficient-independent-providers' }),
    );
    expect(report.remediation.length).toBeGreaterThan(0);
    expect(report.remediation.every((step) => step.length > 0)).toBe(true);
    for (const blocker of report.blockers) {
      expect(blocker.remediation.length).toBeGreaterThan(5);
      expect(['blocker', 'warning']).toContain(blocker.severity);
    }
  });

  it('warns on provisional identity without blocking missions or contract freeze', () => {
    const root = makeRoot();
    write(root, '.context/config/sensors.json', {
      schemaVersion: 1,
      sensors: [
        { id: 'typecheck', command: ['t'], timeoutMs: 1, network: false },
        { id: 'unit', command: ['u'], timeoutMs: 1, network: false },
      ],
    });
    const report = inspectNexusReadiness({
      scope: scope(root, {
        identitySource: 'provisional',
        projectId: 'local-provisional',
      }),
      platform: 'darwin',
      git: gitOk(),
      runtime: { openAndInspect: () => healthyRuntime() },
      inspectContext: () => contextReady(),
      listProviders: () => criticalProviders(),
      multiPc: multiPcOk(),
      pathExists: (candidate) =>
        candidate === '/usr/bin/sandbox-exec' || fs.existsSync(candidate),
    });

    expect(report.ready).toBe(true);
    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'missing-project-manifest' }),
    );
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-project-manifest' }),
    );
  });

  it('validates project.json schema and projectId alignment', () => {
    const root = makeRoot();
    write(root, '.nexus/project.json', { schemaVersion: 1, projectId: 'not-a-uuid' });
    write(root, '.context/config/sensors.json', {
      schemaVersion: 1,
      sensors: [
        { id: 'typecheck', command: ['t'], timeoutMs: 1, network: false },
        { id: 'unit', command: ['u'], timeoutMs: 1, network: false },
      ],
    });
    const report = inspectNexusReadiness({
      scope: scope(root),
      platform: 'darwin',
      git: gitOk(),
      runtime: { openAndInspect: () => healthyRuntime() },
      inspectContext: () => contextReady(),
      listProviders: () => criticalProviders(),
      multiPc: multiPcOk(),
      pathExists: (c) => c === '/usr/bin/sandbox-exec' || fs.existsSync(c),
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-project-manifest' }),
      ]),
    );
  });

  it('quarantines a structurally valid legacy manifest with migration remediation', () => {
    const root = makeRoot();
    const doctorOptions = baseOptions(root);
    write(root, '.nexus/project.json', {
      schemaVersion: 1,
      projectId: '11111111-1111-4111-8111-111111111111',
    });

    const report = inspectNexusReadiness(doctorOptions);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: 'legacy-project-manifest-unverified',
        remediation: expect.stringMatching(/schemaVersion 2|regenere/i),
      }),
    );
  });

  it('quarantines a v2 manifest copied from incompatible Git history', () => {
    const root = makeRoot();
    const doctorOptions = baseOptions(root);
    write(root, '.nexus/project.json', manifestedProject('2'.repeat(40)));

    const report = inspectNexusReadiness(doctorOptions);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: 'project-lineage-mismatch',
        remediation: expect.stringMatching(/clone correto|regenere/i),
      }),
    );
  });

  it('rejects a symlinked project manifest instead of reading authority outside the checkout', () => {
    const root = makeRoot();
    const options = baseOptions(root);
    const outside = path.join(os.tmpdir(), `nexus-doctor-manifest-${Date.now()}.json`);
    fs.writeFileSync(outside, JSON.stringify({
      schemaVersion: 1,
      projectId: '11111111-1111-4111-8111-111111111111',
    }));
    fs.rmSync(path.join(root, '.nexus/project.json'));
    fs.symlinkSync(outside, path.join(root, '.nexus/project.json'));
    try {
      const report = inspectNexusReadiness(options);
      expect(report.ready).toBe(false);
      expect(report.blockers).toContainEqual(
        expect.objectContaining({ code: 'unsafe-project-manifest' }),
      );
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('validates sensor confinement instead of checking IDs only', () => {
    const root = makeRoot();
    const options = baseOptions(root);
    write(root, '.context/config/sensors.json', {
      schemaVersion: 1,
      sensors: [
        { id: 'typecheck', command: ['npm', 'run', 'typecheck'], timeoutMs: 60_000, network: true },
        { id: 'unit', command: [], timeoutMs: 0, network: false },
      ],
    });

    const report = inspectNexusReadiness(options);
    expect(report.ready).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: 'invalid-sensor-definition' }),
    );
  });

  it('warns (not blocks) when enforceable providers fall below the Council ideal', () => {
    const root = makeRoot();
    const providers = criticalProviders();
    const report = inspectNexusReadiness({
      ...baseOptions(root),
      listProviders: () => providers.map((provider, index) => ({
        ...provider,
        readOnlyCapable: index !== 2,
      })),
    });

    // 2 provedores confináveis: quorum de review independente existe (basta 1
    // ≠ autor); abaixo do ideal do Review Council vira warning, não blocker.
    expect(report.ready).toBe(true);
    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'insufficient-independent-providers' }),
    );
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'insufficient-independent-providers' }),
    );
  });

  it('blocks when only one provider exists because independent review is impossible', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness({
      ...baseOptions(root),
      listProviders: () => criticalProviders().slice(0, 1),
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: 'insufficient-independent-providers' }),
    );
  });

  it('flags dirty worktree as warning only', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness({
      ...baseOptions(root),
      git: gitOk(true),
    });
    expect(report.ready).toBe(true);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'dirty-worktree', check: 'git' }),
      ]),
    );
  });

  it('fails closed for Windows sandbox even when other probes are green', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness({
      ...baseOptions(root),
      platform: 'win32',
    });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'sandbox',
          code: 'sandbox-unavailable-windows',
        }),
      ]),
    );
  });

  it('warns for missing multi-pc backends in single-device mode', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness({
      ...baseOptions(root),
      multiPc: {
        leaseBackendConfigured: false,
        syncBackendConfigured: false,
        requireSharedExecution: false,
      },
    });
    expect(report.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'lease-backend-unconfigured' }),
        expect.objectContaining({ code: 'sync-backend-unconfigured' }),
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'lease-backend-unconfigured' }),
        expect.objectContaining({ code: 'sync-backend-unconfigured' }),
      ]),
    );
  });

  it('blocks missing multi-pc backends when shared execution is required', () => {
    const root = makeRoot();
    const report = inspectNexusReadiness({
      ...baseOptions(root),
      multiPc: {
        leaseBackendConfigured: false,
        syncBackendConfigured: false,
      },
    });
    expect(report.ready).toBe(false);
    expect(
      report.blockers.map((item) => item.code).sort(),
    ).toEqual(
      expect.arrayContaining([
        'lease-backend-unconfigured',
        'sync-backend-unconfigured',
      ]),
    );
  });

  it('fails closed when required probes are not injected', () => {
    const root = makeRoot();
    write(root, '.nexus/project.json', {
      schemaVersion: 1,
      projectId: '11111111-1111-4111-8111-111111111111',
    });
    write(root, '.context/config/sensors.json', {
      schemaVersion: 1,
      sensors: [
        { id: 'typecheck', command: ['t'], timeoutMs: 1, network: false },
        { id: 'unit', command: ['u'], timeoutMs: 1, network: false },
      ],
    });
    const report = inspectNexusReadiness({
      scope: scope(root),
      platform: 'darwin',
      git: gitOk(),
      pathExists: (c) => c === '/usr/bin/sandbox-exec' || fs.existsSync(c),
    });

    expect(report.ready).toBe(false);
    expect(report.blockers.map((item) => item.code).sort()).toEqual(
      expect.arrayContaining([
        'runtime-probe-skipped',
        'context-doctor-skipped',
        'providers-probe-skipped',
        'multi-pc-status-unknown',
      ]),
    );
  });

  it('blocks unreadable workspace paths', () => {
    const report = inspectNexusReadiness({
      scope: scope('/path/does/not/exist-nexus-doctor'),
      platform: 'darwin',
      git: gitOk(),
      runtime: { openAndInspect: () => healthyRuntime() },
      inspectContext: () => contextReady(),
      listProviders: () => criticalProviders(),
      multiPc: multiPcOk(),
      pathExists: (c) => c === '/usr/bin/sandbox-exec',
    });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'workspace-missing' }),
      ]),
    );
  });

  it('wraps a manager-like open/close into a runtime health probe', () => {
    const health = healthyRuntime();
    let closed = false;
    const probe = runtimeHealthProbeFromManager({
      open: () => ({ health, close: () => undefined }),
      close: () => {
        closed = true;
        return true;
      },
    });
    expect(probe.openAndInspect(scope('/tmp')).status).toBe('healthy');
    expect(closed).toBe(true);
  });
});
