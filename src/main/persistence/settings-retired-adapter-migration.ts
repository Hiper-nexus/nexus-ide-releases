import {
  adapterCapabilityMatrixOf,
  orchestrationEvidenceOf,
  type AdapterInfo,
} from "../../shared/adapter-types";
import { isRetiredAdapterId } from "../../shared/retired-adapter-policy";
import type { OrchSettings } from "../../shared/settings-types";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";

const VERIFIED_FALLBACK_ORDER = ["claude", "codex"] as const;

export type RetiredOrchestratorSettingsMigration =
  | {
      readonly changed: false;
      readonly settings: OrchSettings;
    }
  | {
      readonly changed: true;
      readonly settings: OrchSettings;
      readonly previousAdapterId: string;
      readonly fallbackAdapterId: string;
      readonly fallbackInstalled: boolean;
    };

function isMainOwnedOrchestratorRoute(adapter: AdapterInfo): boolean {
  const capabilities = adapterCapabilityMatrixOf(adapter);
  return (
    adapter.kind === "cli-pty" &&
    adapter.missionControlCapable === true &&
    capabilities.launchable &&
    capabilities.promptInjectable &&
    capabilities.statusObservable
  );
}

function fallbackRank(adapter: AdapterInfo): readonly number[] {
  const verifiedRank =
    orchestrationEvidenceOf(adapter) === "verified" ? 0 : 1;
  const preferredIndex = VERIFIED_FALLBACK_ORDER.indexOf(
    adapter.id as (typeof VERIFIED_FALLBACK_ORDER)[number],
  );
  return [
    verifiedRank,
    preferredIndex < 0 ? VERIFIED_FALLBACK_ORDER.length : preferredIndex,
  ];
}

function compareFallbacks(left: AdapterInfo, right: AdapterInfo): number {
  const leftRank = fallbackRank(left);
  const rightRank = fallbackRank(right);
  return (
    leftRank[0]! - rightRank[0]! ||
    leftRank[1]! - rightRank[1]! ||
    left.id.localeCompare(right.id)
  );
}

export function planRetiredOrchestratorSettingsMigration(input: {
  readonly settings: OrchSettings;
  readonly adapters: readonly AdapterInfo[];
  readonly enabledAdapterIds: ReadonlySet<string>;
}): RetiredOrchestratorSettingsMigration {
  const previousAdapterId = input.settings.defaultAdapterId.trim();
  if (!isRetiredAdapterId(previousAdapterId)) {
    return { changed: false, settings: input.settings };
  }

  const operatorChoice = isOperatorChoicePolicy(
    input.settings.squadCliPolicy,
  );
  const enabled = input.adapters.filter(
    (adapter) =>
      !isRetiredAdapterId(adapter.id) &&
      input.enabledAdapterIds.has(adapter.id),
  );
  const policyEligible = enabled.filter((adapter) =>
    operatorChoice
      ? isMainOwnedOrchestratorRoute(adapter)
      : isMainOwnedOrchestratorRoute(adapter) &&
        orchestrationEvidenceOf(adapter) === "verified",
  );
  const installed = policyEligible
    .filter((adapter) => adapter.installed)
    .sort(compareFallbacks);
  const loadedVerified = enabled
    .filter(
      (adapter) =>
        isMainOwnedOrchestratorRoute(adapter) &&
        orchestrationEvidenceOf(adapter) === "verified",
    )
    .sort(compareFallbacks);
  const fallback = installed[0] ?? loadedVerified[0];

  // Claude is the built-in, release-qualified recovery target when this
  // machine has no currently executable Maestro. The settings no longer point
  // at a removed provider, while the existing readiness UI gives the operator
  // the precise install/login action instead of inventing an unsafe route.
  const fallbackAdapterId = fallback?.id ?? "claude";
  return {
    changed: true,
    previousAdapterId,
    fallbackAdapterId,
    fallbackInstalled: fallback?.installed === true,
    settings: {
      ...input.settings,
      defaultAdapterId: fallbackAdapterId,
      // Models and accounts are provider-bound opaque ids. Carrying either
      // across providers recreates an immediate "unavailable" launch failure.
      defaultModel: "",
      defaultAccountId: "",
    },
  };
}
