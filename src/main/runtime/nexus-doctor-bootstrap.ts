import type { Adapter } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { getAdapter } from '../adapters/adapter-registry';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import { listProviderSettings } from '../persistence/provider-config-store';
import { secureAutonomousCliArgs } from '../pty/autonomous-cli-policy';
import {
  configureNexusDoctor,
  disposeNexusDoctor,
  type ContextDoctorSnapshot,
  type IndependentProviderSnapshot,
  type MultiPcBackendStatus,
  type NexusDoctorOptions,
  type NexusDoctorReport,
} from './nexus-doctor';
import { inspectNexusReadinessAsync } from './nexus-doctor-async';
import type { ProjectRuntimeManager } from './project-runtime-manager';

export interface NexusDoctorRuntimeConfiguration {
  readonly runtimeManager: ProjectRuntimeManager;
  readonly multiPc: MultiPcBackendStatus;
  readonly minIndependentProviders?: number;
}

interface NexusDoctorBootstrapDependencies {
  readonly inspectReadiness: (
    options: NexusDoctorOptions,
  ) => NexusDoctorReport | Promise<NexusDoctorReport>;
  readonly inspectContext: (scope: ProjectExecutionScope) => ContextDoctorSnapshot;
  readonly listProviderSettings: () => readonly ProviderSettingsInfo[];
  readonly getAdapter: (adapterId: string) => Adapter | null;
  readonly secureReadOnlyArgs: (
    adapter: Extract<Adapter, { kind: 'cli-pty' }>,
    args: readonly string[],
    readOnly: boolean,
  ) => readonly string[];
}

const DEFAULT_DEPENDENCIES: NexusDoctorBootstrapDependencies = {
  inspectReadiness: inspectNexusReadinessAsync,
  inspectContext: (scope) => getContextWorkflowService(scope).inspectReadiness(),
  listProviderSettings,
  getAdapter,
  secureReadOnlyArgs: secureAutonomousCliArgs,
};

export function buildMultiPcBackendStatus(
  leaseBackendConfigured: boolean,
  syncBackendConfigured: boolean,
): MultiPcBackendStatus {
  return Object.freeze({
    leaseBackendConfigured,
    syncBackendConfigured,
    requireSharedExecution:
      leaseBackendConfigured || syncBackendConfigured,
  });
}

function canEnforceReadOnly(
  provider: ProviderSettingsInfo,
  dependencies: NexusDoctorBootstrapDependencies,
): boolean {
  const adapter = dependencies.getAdapter(provider.adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') return false;
  try {
    dependencies.secureReadOnlyArgs(adapter, provider.extraArgs, true);
    return true;
  } catch {
    return false;
  }
}

export function buildDoctorProviderSnapshot(
  provider: ProviderSettingsInfo,
  dependencies: Pick<
    NexusDoctorBootstrapDependencies,
    'getAdapter' | 'secureReadOnlyArgs'
  > = DEFAULT_DEPENDENCIES,
): IndependentProviderSnapshot {
  return Object.freeze({
    adapterId: provider.adapterId,
    enabled: provider.enabled,
    installed: provider.installed,
    kind: provider.kind,
    authStrategy: provider.authStrategy,
    readOnlyCapable: canEnforceReadOnly(
      provider,
      { ...DEFAULT_DEPENDENCIES, ...dependencies },
    ),
  });
}

export function configureNexusDoctorRuntime(
  configuration: NexusDoctorRuntimeConfiguration,
  dependencyOverrides: Partial<NexusDoctorBootstrapDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const runtime = configuration.runtimeManager;
  const multiPc = Object.freeze({ ...configuration.multiPc });
  configureNexusDoctor((scope) =>
    dependencies.inspectReadiness({
      scope,
      runtime: {
        // The manager owns this cached handle. Do not close a runtime shared
        // by context/domain stores while a diagnostic request is running.
        openAndInspect: (requestedScope) => runtime.open(requestedScope).health,
      },
      inspectContext: dependencies.inspectContext,
      listProviders: () =>
        dependencies
          .listProviderSettings()
          .filter((provider) => provider.adapterId !== 'shell')
          .map((provider) => buildDoctorProviderSnapshot(provider, dependencies)),
      multiPc,
      minIndependentProviders: configuration.minIndependentProviders,
    }),
  );
}

export function disposeNexusDoctorRuntime(): void {
  disposeNexusDoctor();
}
