import type { AdapterInfo } from "../../shared/adapter-types";
import {
  adapterCapabilityMatrixOf,
  orchestrationEvidenceOf,
} from "../../shared/adapter-types";
import type { Squad } from "../../shared/orch-types";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { listAdapterInfos } from "../adapters/adapter-registry";
import { hasAvailableAccount } from "../persistence/account-store";
import { listProviderSettings } from "../persistence/provider-config-store";
import { getOrchSettings } from "../persistence/settings-store";
import {
  assessStandardSquadReadiness,
  buildSquadRuntimeCliPolicy,
  squadRuntimeModelsForCli,
  type SquadRuntimeCliPolicy,
} from "./squad-runtime-policy";

export interface LiveSquadRuntimeInventory {
  readonly policy: SquadRuntimeCliPolicy;
  readonly adapters: readonly AdapterInfo[];
  readonly workerAdapters: readonly AdapterInfo[];
  /** Policy-qualified candidates that may own the Maestro session. */
  readonly orchestratorAdapters: readonly AdapterInfo[];
  readonly verifiedOrchestrators: readonly AdapterInfo[];
  readonly verifiedOrchestratorCliIds: ReadonlySet<string>;
}

/**
 * Rebuild the autonomous route inventory from main-owned adapter metadata,
 * provider readiness and account state. A persisted provider row is never
 * sufficient by itself. A guided worker must have either physical MCP or the
 * Main-owned PTY-stream handoff route.
 */
export function liveSquadRuntimeInventory(): LiveSquadRuntimeInventory {
  const adapterInfos = listAdapterInfos();
  const adapterById = new Map(
    adapterInfos.map((adapter) => [adapter.id, adapter] as const),
  );
  const providers = listProviderSettings();
  const operatorChoice = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  const policy = buildSquadRuntimeCliPolicy(
    providers.map((provider) => {
      const adapter = adapterById.get(provider.adapterId);
      return Object.freeze({
        ...provider,
        adapterLoaded: adapter !== undefined,
        // Worker completion remains independent from Maestro mission control.
        guidedHandoffCapable:
          adapter?.kind === "cli-pty" &&
          adapter.taskHandoffCapable === true,
        autonomousWorkspaceWriteCapable:
          adapter?.kind === "cli-pty" &&
          adapter.autonomousWorkspaceWriteCapable === true,
      });
    }),
    hasAvailableAccount,
    operatorChoice,
  );
  const providerById = new Map(
    providers.map((provider) => [provider.adapterId, provider] as const),
  );
  const adapters = adapterInfos
    .filter(
      (adapter) =>
        adapter.id !== "shell" && policy.routableCliIds.has(adapter.id),
    )
    .map((adapter) => {
      const credentiallessDefault =
        policy.credentiallessDefaultModelByCliId[adapter.id];
      const models = [
        ...squadRuntimeModelsForCli(
          policy,
          adapter.id,
          providerById.get(adapter.id)?.models ?? adapter.models.list,
        ),
      ];
      const originalModels =
        providerById.get(adapter.id)?.models ?? adapter.models.list;
      const modelCatalogChanged =
        models.length !== originalModels.length ||
        models.some((model, index) => model !== originalModels[index]);
      if (
        !policy.credentiallessOnlyCliIds.has(adapter.id) &&
        !modelCatalogChanged
      ) {
        return adapter;
      }
      if (
        credentiallessDefault &&
        !models.includes(credentiallessDefault)
      ) {
        models.unshift(credentiallessDefault);
      }
      const effectiveDefault =
        credentiallessDefault ??
        (models.includes(adapter.models.default)
          ? adapter.models.default
          : models[0]);
      if (!effectiveDefault) return adapter;
      return Object.freeze({
        ...adapter,
        models: Object.freeze({
          list: Object.freeze(models) as unknown as string[],
          default: effectiveDefault,
        }),
      });
    });
  const verifiedOrchestrators = adapters.filter(
    (adapter) => orchestrationEvidenceOf(adapter) === "verified",
  );
  const orchestratorAdapters = operatorChoice
    ? adapters.filter((adapter) => {
        const capabilities = adapterCapabilityMatrixOf(adapter);
        return (
          adapter.kind === "cli-pty" &&
          adapter.missionControlCapable === true &&
          capabilities.launchable &&
          capabilities.promptInjectable &&
          capabilities.statusObservable
        );
      })
    : verifiedOrchestrators;
  return Object.freeze({
    policy,
    adapters: Object.freeze(adapters),
    workerAdapters: Object.freeze(
      adapters.filter((adapter) =>
        policy.routableWorkerCliIds.has(adapter.id),
      ),
    ),
    orchestratorAdapters: Object.freeze(orchestratorAdapters),
    verifiedOrchestrators: Object.freeze(verifiedOrchestrators),
    verifiedOrchestratorCliIds: new Set(
      verifiedOrchestrators.map((adapter) => adapter.id),
    ),
  });
}

/**
 * Final main-process boundary for guided/standard missions. This rechecks the
 * complete saved roster immediately before native approval/plan promotion so
 * an edited legacy worker cannot enter a scheduler that requires physical
 * receipts and then wait forever.
 */
export function assertLiveGuidedSquadReadiness(squad: Squad): void {
  const inventory = liveSquadRuntimeInventory();
  const readiness = assessStandardSquadReadiness(
    squad.agents,
    inventory.policy,
    inventory.verifiedOrchestratorCliIds,
    isOperatorChoicePolicy(getOrchSettings().squadCliPolicy),
  );
  if (readiness.ok) return;
  throw new Error(
    `squad_runtime_unavailable:${readiness.code}: ${readiness.detail}`,
  );
}
