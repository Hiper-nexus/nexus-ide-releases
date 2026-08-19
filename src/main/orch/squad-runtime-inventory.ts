import type { AdapterInfo } from "../../shared/adapter-types";
import { orchestrationEvidenceOf } from "../../shared/adapter-types";
import type { Squad } from "../../shared/orch-types";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { listAdapterInfos } from "../adapters/adapter-registry";
import { refreshKimiSeatReadiness } from "../adapters/kimi-seat-probe";
import {
  classifySeatAuth,
  peekKimiSeatReadiness,
} from "../adapters/seat-auth-readiness";
import { warmKeychainOnlySubscriptionAuth } from "../adapters/subscription-auth";
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
        seatAuthReadiness: classifySeatAuth({
          adapterId: provider.adapterId,
          authStrategy: provider.authStrategy,
          hasKey: provider.hasKey,
          kimiListReadiness:
            provider.adapterId === "kimi"
              ? peekKimiSeatReadiness()
              : undefined,
        }),
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
  // Doutrina fluxo-por-padrão: o inventário não esconde CLI instalada por
  // estado de rota/auth — isso escondia coordenadores reais e derrubava o
  // bootstrap com `squad_missing`. Rota/credencial continuam enriquecendo o
  // catálogo de modelos abaixo; deixar de PARTICIPAR só acontece por não
  // estar instalada (ou ser o shell, que não é agente).
  const adapters = adapterInfos
    .filter((adapter) => adapter.id !== "shell" && adapter.installed)
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
  // Metadado de capacidade ORDENA (controle de missão primeiro), não filtra:
  // qualquer cli-pty instalada pode ocupar a sessão do Maestro. Sob
  // `governed` (opt-in) a lista verificada continua sendo a autoridade.
  const cliPtyAdapters = adapters.filter(
    (adapter) => adapter.kind === "cli-pty",
  );
  const orchestratorAdapters = operatorChoice
    ? [...cliPtyAdapters].sort(
        (left, right) =>
          Number(right.missionControlCapable === true) -
          Number(left.missionControlCapable === true),
      )
    : verifiedOrchestrators;
  return Object.freeze({
    policy,
    adapters: Object.freeze(adapters),
    workerAdapters: Object.freeze(cliPtyAdapters),
    orchestratorAdapters: Object.freeze(orchestratorAdapters),
    verifiedOrchestrators: Object.freeze(verifiedOrchestrators),
    verifiedOrchestratorCliIds: new Set(
      verifiedOrchestrators.map((adapter) => adapter.id),
    ),
  });
}

/**
 * Async companion to the sync inventory above. AGY 1.1 keeps its session
 * token ONLY in the macOS login keychain, and the sync inventory deliberately
 * reads only the warm status cache (main-loop safety), so a cold cache reads
 * a live operator session as `login-needed` and the readiness gate blocks a
 * healthy roster. Every async boundary that precedes a sync readiness check
 * (mission approve/promote IPC, kickoff submit, orchestrator bootstrap, squad
 * design, route_task, reviewer quorum) must await this first; the probe is
 * async and memoized, so the sync gate right after it sees reality.
 */
export async function warmSquadRuntimeSubscriptionAuth(
  cliIds: readonly string[] = listProviderSettings().map(
    (provider) => provider.adapterId,
  ),
): Promise<void> {
  await Promise.all([
    ...[...new Set(cliIds)].map((cliId) =>
      warmKeychainOnlySubscriptionAuth(cliId),
    ),
    refreshKimiSeatReadiness().catch(() => undefined),
  ]);
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
