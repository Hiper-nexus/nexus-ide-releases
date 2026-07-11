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
import { AgentAwakeService } from '../agent-awake-service';
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
  shouldRecordProcessGoneCrash,
  shouldRecoverRendererAfterProcessGone,
  type ExpectedTeardownScope,
  type ProcessGoneSource,
} from '../crash-reporting/process-gone-classification';
import { ProcessGoneDedupe } from '../crash-reporting/process-gone-dedupe';
import {
  buildProcessGoneCrashDetails,
  setProcessGoneDiagnosticsApp,
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
let diagnosticsAppBound = false;

function ensureDiagnosticsApp(): void {
  if (diagnosticsAppBound) return;
  try {
    setProcessGoneDiagnosticsApp({
      getAppMetrics: () => app.getAppMetrics?.() ?? [],
    });
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
}): void {
  crashReportStore = options?.crashReportStore ?? null;
  awakeService = options?.awakeService ?? null;
  diagnosticsAppBound = false;
  // Reset per-run trackers so dedupe/GPU-window state does not leak across tests.
  processGoneDedupe = new ProcessGoneDedupe();
  gpuFallbackTracker = newGpuFallbackTracker();
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
    const details = buildProcessGoneCrashDetails({
      processType: 'renderer',
      reason,
      exitCode,
    });
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

  let gpuFallbackEngaged = false;
  if (
    isGpuFallbackCrashCandidate({
      platform: process.platform,
      processType: 'gpu',
      reason,
    })
  ) {
    const ms = input.msSinceLaunch ?? 0;
    gpuFallbackEngaged = gpuFallbackTracker.recordGpuCrash(ms).shouldEngageFallback;
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
  service.setStatuses([
    {
      state: status,
      receivedAt: Date.now(),
      observedInCurrentRuntime: true,
    },
  ]);
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
}
