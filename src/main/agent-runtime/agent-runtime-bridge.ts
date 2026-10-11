/**
 * Production facade for ORCA F3 agent-runtime harvest.
 * Single seam (mirrors remote-terminal-streams for F5): process-gone / crash
 * reporting, agent-hook activity → PaneSessionState, and agent-awake lifecycle.
 *
 * Invariant (§12.4): hooks inform activity only; never evidence/completion.
 */

import { app } from 'electron';
import os from 'node:os';
import type { AgentStatusState } from '../../shared/agent-status-types';
import type { PaneSessionState } from '../../shared/types';
import {
  AgentAwakeService,
  type AgentAwakeStatus,
} from '../agent-awake-service';
import {
  mapAgentHookStatusToPaneSession,
  type AgentHookActivityMapping,
} from '../agent-hooks/agent-hook-activity-mapper';
import {
  recordCrashBreadcrumb,
  getCrashBreadcrumbSnapshot,
} from '../crash-reporting/crash-breadcrumb-store';
import { CrashReportStore } from '../crash-reporting/crash-report-store';
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate,
} from '../crash-reporting/gpu-crash-fallback-decision';
import {
  writeGpuFallbackMarker,
  type WindowsGpuFallbackEnvironment,
} from '../crash-reporting/gpu-fallback-marker';
import { writeCrashReportPending } from '../crash-reporting/crash-report-pending';
import {
  shouldRecordProcessGoneCrash,
  shouldRecoverRendererAfterProcessGone,
  type ExpectedTeardownScope,
  type ProcessGoneSource,
} from '../crash-reporting/process-gone-classification';
import { ProcessGoneDedupe } from '../crash-reporting/process-gone-dedupe';
import {
  buildProcessGoneCrashDetails,
  setProcessGoneDiagnosticsApp,
  startPreGoneCrashSampling,
} from '../crash-reporting/process-gone-diagnostics';
import { publishSessionActivityState } from '../pty/pty-manager';
import type { RendererRecoveryCircuitBreaker } from '../reliability/renderer-recovery-circuit-breaker';

export type RenderProcessGoneDetails = {
  reason: string;
  exitCode?: number;
};

export type HandleRenderProcessGoneInput = {
  details: RenderProcessGoneDetails;
  circuitBreaker: RendererRecoveryCircuitBreaker;
  now?: number;
  expectedTeardown?: ExpectedTeardownScope;
  /** ms since app launch — for GPU fallback window */
  msSinceLaunch?: number;
  windowDestroyed?: boolean;
};

export type HandleRenderProcessGoneResult = {
  recorded: boolean;
  recover: boolean;
  recoveryAllowed: boolean;
  showRecoveryScreen: boolean;
  reload: boolean;
  gpuFallbackEngaged: boolean;
};

function newGpuFallbackTracker(): GpuCrashFallbackTracker {
  return new GpuCrashFallbackTracker({
    windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
    threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  });
}

// `let`, not `const`: these carry per-run mutable state (dedupe keys, GPU crash
// window) and are reset between tests via __resetAgentRuntimeBridgeForTests,
// otherwise state leaks across cases and produces order-dependent flakiness.
let processGoneDedupe = new ProcessGoneDedupe();
let gpuFallbackTracker = newGpuFallbackTracker();

let crashReportStore: CrashReportStore | null = null;
let awakeService: AgentAwakeService | null = null;
let awakeStatusesBySession = new Map<string, AgentAwakeStatus>();
let diagnosticsAppBound = false;
/** userData path for GPU marker + crash-report-pending (injected in tests). */
let bridgeUserDataPath: string | null = null;
let gpuFallbackAlreadyActive = false;

function resolveUserDataPath(): string {
  if (bridgeUserDataPath) return bridgeUserDataPath;
  try {
    return app.getPath('userData');
  } catch {
    return `${process.env.TMPDIR ?? '/tmp'}/nexus-agent-runtime-test-${process.pid}`;
  }
}

function appVersionSafe(): string {
  try {
    return app.getVersion();
  } catch {
    return 'test';
  }
}

function ensureDiagnosticsApp(): void {
  if (diagnosticsAppBound) return;
  try {
    setProcessGoneDiagnosticsApp({
      getAppMetrics: () => app.getAppMetrics?.() ?? [],
    });
    // Sampled every 60 s (unref'd): process-gone metrics only see survivors,
    // so the last whole-app sample is what names the process that died.
    startPreGoneCrashSampling();
    diagnosticsAppBound = true;
  } catch {
    // Tests without electron app — leave unset; classification still works.
  }
}

function getCrashReportStore(): CrashReportStore {
  if (!crashReportStore) {
    try {
      crashReportStore = CrashReportStore.fromUserData(app.getPath('userData'));
    } catch {
      // Fallback for unit tests without electron userData. Per-pid path so
      // parallel vitest workers do not clobber a shared file.
      crashReportStore = new CrashReportStore(
        `${process.env.TMPDIR ?? '/tmp'}/nexus-crash-reports-test-${process.pid}.json`,
      );
    }
  }
  return crashReportStore;
}

/** Test/DI: inject store and reset singletons. */
export function __resetAgentRuntimeBridgeForTests(options?: {
  crashReportStore?: CrashReportStore;
  awakeService?: AgentAwakeService;
  userDataPath?: string;
  gpuFallbackAlreadyActive?: boolean;
}): void {
  crashReportStore = options?.crashReportStore ?? null;
  // F-1213: dropping a live service without dispose left its real
  // caffeinate/systemd-inhibit running after the test (the F-1186 orphans).
  if (awakeService && awakeService !== options?.awakeService) awakeService.dispose();
  awakeService = options?.awakeService ?? null;
  awakeStatusesBySession = new Map();
  diagnosticsAppBound = false;
  bridgeUserDataPath = options?.userDataPath ?? null;
  gpuFallbackAlreadyActive = options?.gpuFallbackAlreadyActive ?? false;
  // Reset per-run trackers so dedupe/GPU-window state does not leak across tests.
  processGoneDedupe = new ProcessGoneDedupe();
  gpuFallbackTracker = newGpuFallbackTracker();
}

/** Production: mark that this launch already applied software GPU fallback. */
export function setGpuFallbackActiveThisLaunch(active: boolean): void {
  gpuFallbackAlreadyActive = active;
}

export function configureAgentRuntimeUserDataPath(userDataPath: string | null): void {
  bridgeUserDataPath = userDataPath;
}

/**
 * Production render-process-gone handler. Classifies, dedupes, breadcrumbs,
 * optional crash report, GPU fallback signal; then applies circuit breaker.
 */
export function handleRenderProcessGone(
  input: HandleRenderProcessGoneInput,
): HandleRenderProcessGoneResult {
  ensureDiagnosticsApp();
  const now = input.now ?? Date.now();
  const reason = input.details.reason ?? 'unknown';
  const exitCode =
    typeof input.details.exitCode === 'number' ? input.details.exitCode : null;
  const expectedTeardown: ExpectedTeardownScope =
    input.expectedTeardown ?? 'none';
  const source: ProcessGoneSource = 'renderer';

  const shouldRecord = shouldRecordProcessGoneCrash({
    platform: process.platform,
    source,
    processType: 'renderer',
    reason,
    exitCode,
    expectedTeardown,
  });
  const dedupeKey = `renderer:${reason}:${exitCode ?? 'null'}`;
  const recordAllowed = shouldRecord && processGoneDedupe.shouldRecord(dedupeKey, now);

  if (recordAllowed) {
    recordCrashBreadcrumb('render-process-gone', {
      reason,
      exitCode,
      expectedTeardown,
    });
    const details = buildProcessGoneCrashDetails(
      {
        processType: 'renderer',
        reason,
        exitCode,
      },
      'renderer',
    );
    void getCrashReportStore()
      .record({
        source: 'renderer',
        processType: 'renderer',
        reason,
        exitCode,
        appVersion: (() => {
          try {
            return app.getVersion();
          } catch {
            return 'test';
          }
        })(),
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        electronVersion: process.versions.electron ?? 'unknown',
        chromeVersion: process.versions.chrome ?? 'unknown',
        details,
        breadcrumbs: getCrashBreadcrumbSnapshot(),
      })
      .catch((err) => {
        console.warn('[agent-runtime] crash report record failed:', err);
      });
  } else if (shouldRecord) {
    recordCrashBreadcrumb('render-process-gone-deduped', { reason, exitCode });
  }

  // Renderer path does not drive GPU child fallback; child-process-gone does.
  const gpuFallbackEngaged = false;

  if (recordAllowed) {
    try {
      writeCrashReportPending(resolveUserDataPath(), {
        source: 'renderer',
        processType: 'renderer',
        reason,
        exitCode,
      });
    } catch (err) {
      console.warn('[agent-runtime] crash-report-pending write failed:', err);
    }
  }

  if (input.windowDestroyed) {
    return {
      recorded: recordAllowed,
      recover: false,
      recoveryAllowed: false,
      showRecoveryScreen: false,
      reload: false,
      gpuFallbackEngaged,
    };
  }

  // Preserve prior window.ts early-outs for clean/killed exits.
  if (reason === 'clean-exit' || reason === 'killed') {
    return {
      recorded: recordAllowed,
      recover: false,
      recoveryAllowed: false,
      showRecoveryScreen: false,
      reload: false,
      gpuFallbackEngaged,
    };
  }

  const recover = shouldRecoverRendererAfterProcessGone({
    reason,
    expectedTeardown,
  });
  if (!recover) {
    return {
      recorded: recordAllowed,
      recover: false,
      recoveryAllowed: false,
      showRecoveryScreen: false,
      reload: false,
      gpuFallbackEngaged,
    };
  }

  const recovery = input.circuitBreaker.registerRecoveryAttempt(now);
  if (!recovery.allowed) {
    return {
      recorded: recordAllowed,
      recover: true,
      recoveryAllowed: false,
      showRecoveryScreen: true,
      reload: false,
      gpuFallbackEngaged,
    };
  }

  return {
    recorded: recordAllowed,
    recover: true,
    recoveryAllowed: true,
    showRecoveryScreen: false,
    reload: true,
    gpuFallbackEngaged,
  };
}

export type ChildProcessGoneDetails = {
  type?: string;
  reason: string;
  exitCode?: number | null;
  name?: string;
  serviceName?: string;
};

export type HandleChildProcessGoneInput = {
  details: ChildProcessGoneDetails;
  now?: number;
  expectedTeardown?: ExpectedTeardownScope;
  /** ms since app launch — for GPU fallback window */
  msSinceLaunch?: number;
};

export type HandleChildProcessGoneResult = {
  recorded: boolean;
  gpuFallbackEngaged: boolean;
  source: 'child';
};

/**
 * Production child-process-gone handler (GPU / utility). Classifies, dedupes,
 * breadcrumbs; persists GPU fallback marker for next launch when threshold hit.
 */
export function handleChildProcessGone(
  input: HandleChildProcessGoneInput,
): HandleChildProcessGoneResult {
  ensureDiagnosticsApp();
  const now = input.now ?? Date.now();
  const reason = input.details.reason ?? 'unknown';
  const exitCode =
    typeof input.details.exitCode === 'number' ? input.details.exitCode : null;
  const processType = input.details.type ?? 'unknown';
  const serviceName = input.details.serviceName;
  const expectedTeardown: ExpectedTeardownScope =
    input.expectedTeardown ?? 'none';
  const source: ProcessGoneSource = 'child';

  const shouldRecord = shouldRecordProcessGoneCrash({
    platform: process.platform,
    source,
    processType,
    serviceName,
    reason,
    exitCode,
    expectedTeardown,
  });
  const dedupeKey = `child:${processType}:${serviceName ?? ''}:${reason}:${exitCode ?? 'null'}`;
  const recordAllowed = shouldRecord && processGoneDedupe.shouldRecord(dedupeKey, now);

  if (recordAllowed) {
    recordCrashBreadcrumb('child-process-gone', {
      reason,
      exitCode,
      processType,
      serviceName: serviceName ?? null,
    });
    const details = buildProcessGoneCrashDetails(
      {
        processType,
        reason,
        exitCode,
        serviceName,
      },
      processType,
    );
    void getCrashReportStore()
      .record({
        source: 'child',
        processType,
        reason,
        exitCode,
        appVersion: appVersionSafe(),
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        electronVersion: process.versions.electron ?? 'unknown',
        chromeVersion: process.versions.chrome ?? 'unknown',
        details,
        breadcrumbs: getCrashBreadcrumbSnapshot(),
      })
      .catch((err) => {
        console.warn('[agent-runtime] crash report record failed:', err);
      });
    try {
      writeCrashReportPending(resolveUserDataPath(), {
        source: 'child',
        processType,
        reason,
        exitCode,
      });
    } catch (err) {
      console.warn('[agent-runtime] crash-report-pending write failed:', err);
    }
  } else if (shouldRecord) {
    recordCrashBreadcrumb('child-process-gone-deduped', {
      reason,
      exitCode,
      processType,
    });
  }

  let gpuFallbackEngaged = false;
  if (
    !gpuFallbackAlreadyActive &&
    isGpuFallbackCrashCandidate({
      platform: process.platform,
      processType,
      reason,
    })
  ) {
    const ms = input.msSinceLaunch ?? 0;
    const result = gpuFallbackTracker.recordGpuCrash(ms);
    if (result.shouldEngageFallback) {
      gpuFallbackEngaged = true;
      try {
        const env: WindowsGpuFallbackEnvironment = {
          appVersion: appVersionSafe(),
          electronVersion: process.versions.electron ?? 'unknown',
          platform: 'win32',
        };
        writeGpuFallbackMarker(
          resolveUserDataPath(),
          {
            engagedAt: now,
            crashesInWindow: result.crashesInWindow,
          },
          env,
        );
        recordCrashBreadcrumb('gpu_fallback_engaged', {
          reason,
          exitCode,
          crashesInWindow: result.crashesInWindow,
        });
      } catch (err) {
        console.warn('[agent-runtime] gpu fallback marker write failed:', err);
      }
    }
  }

  return {
    recorded: recordAllowed,
    gpuFallbackEngaged,
    source: 'child',
  };
}

export type PublishAgentHookActivityResult = AgentHookActivityMapping & {
  readonly sessionId: string;
  readonly published: boolean;
  readonly paneSessionState: PaneSessionState;
};

/**
 * Map provider hook status → pane session state and publish via pty taps.
 * Never authorizes evidence or mission completion.
 */
export function publishAgentHookActivity(
  status: AgentStatusState,
  ctx: { sessionId: string; agentType?: string | null },
): PublishAgentHookActivityResult {
  const mapping = mapAgentHookStatusToPaneSession(status);
  const published = publishSessionActivityState(
    ctx.sessionId,
    mapping.paneSessionState,
  );
  // Keep machine awake while provider reports working.
  const service = getAgentAwakeService();
  service.setEnabled(true);
  const nextStatuses = new Map(awakeStatusesBySession);
  if (status === 'working') {
    nextStatuses.set(ctx.sessionId, {
      state: status,
      receivedAt: Date.now(),
      observedInCurrentRuntime: true,
    });
  } else {
    nextStatuses.delete(ctx.sessionId);
  }
  awakeStatusesBySession = nextStatuses;
  service.setStatuses([...nextStatuses.values()]);
  recordCrashBreadcrumb('agent-hook-activity', {
    sessionId: ctx.sessionId,
    status,
    agentType: ctx.agentType ?? null,
    paneSessionState: mapping.paneSessionState,
    authorizesEvidence: false,
  });
  return {
    ...mapping,
    sessionId: ctx.sessionId,
    published,
    paneSessionState: mapping.paneSessionState,
  };
}

export function getAgentAwakeService(): AgentAwakeService {
  if (!awakeService) {
    awakeService = new AgentAwakeService();
    awakeService.setEnabled(true);
  }
  return awakeService;
}

export function disposeAgentAwakeService(): void {
  awakeService?.dispose();
  awakeService = null;
  awakeStatusesBySession = new Map();
}
