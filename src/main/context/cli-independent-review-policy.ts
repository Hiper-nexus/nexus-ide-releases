import type { CliPtyAdapter } from '../../shared/adapter-types';
import { isOperatorChoicePolicy } from '../../shared/squad-cli-policy';
import {
  getAdapter,
  isBuiltinAdapter,
} from '../adapters/adapter-registry';
import {
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
} from '../adapters/model-auth-readiness';
import { hasAvailableAccount } from '../persistence/account-store';
import { listProviderSettings } from '../persistence/provider-config-store';
import { getOrchSettings } from '../persistence/settings-store';
import {
  supportsEnforceableReadOnlyNativeAuthority,
  supportsEnforceableWorkspaceWriteNativeAuthority,
} from '../pty/autonomous-cli-policy';

export interface IndependentCliReviewCandidate {
  readonly adapterId: string;
  readonly models: readonly string[];
}

const PHYSICAL_REVIEW_MCP_INJECTIONS = new Set([
  'codex',
  'opencode',
  'kimi',
  'grok',
]);

/**
 * Review completion requires interactive Nexus tools, not merely a final task
 * handoff transport. AGY 1.1 is intentionally absent: it ignores private HOME
 * MCP overlays and therefore cannot physically call merge/context review tools.
 */
export function hasPhysicalNexusReviewToolRoute(
  adapter: CliPtyAdapter,
): boolean {
  if (adapter.quirks.mcpAutoload === true) return true;
  return (
    typeof adapter.quirks.nexusMcp === 'string' &&
    PHYSICAL_REVIEW_MCP_INJECTIONS.has(adapter.quirks.nexusMcp)
  );
}

function authReadyModels(provider: {
  readonly adapterId: string;
  readonly authStrategy: string;
  readonly authReadyModels?: readonly string[];
  readonly models: readonly string[];
  readonly defaultModel?: string;
}): readonly string[] {
  const models = [
    ...provider.models,
    ...(provider.defaultModel ? [provider.defaultModel] : []),
  ];
  return Object.freeze([
    ...new Set(authReadyModelsForProvider(provider, models)),
  ]);
}

/**
 * Main-owned live inventory for independent merge and context reviewers.
 *
 * Autopilot/operator-choice admits every trusted builtin CLI that is enabled,
 * installed, authenticated and has a real Nexus review-tool transport.
 * Hardened preserves the release-qualified Codex-only mechanical boundary.
 */
export function listIndependentCliReviewCandidates(
  options: { readonly reserveClaude?: boolean } = {},
): readonly IndependentCliReviewCandidate[] {
  const operatorChoice = isOperatorChoicePolicy(
    getOrchSettings().squadCliPolicy,
  );
  const candidates: IndependentCliReviewCandidate[] = [];

  for (const provider of listProviderSettings()) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.kind !== 'cli-pty' ||
      (options.reserveClaude === true && provider.adapterId === 'claude')
    ) {
      continue;
    }
    const adapter = getAdapter(provider.adapterId);
    if (
      adapter?.kind !== 'cli-pty' ||
      !isBuiltinAdapter(adapter.id) ||
      !hasPhysicalNexusReviewToolRoute(adapter) ||
      (!operatorChoice &&
        (adapter.id !== 'codex' ||
          !supportsEnforceableWorkspaceWriteNativeAuthority(adapter) ||
          !supportsEnforceableReadOnlyNativeAuthority(adapter)))
    ) {
      continue;
    }
    const authModels = authReadyModels(provider);
    if (authModels.length === 0) continue;
    const models = hasAvailableAccount(provider.adapterId)
      ? authModels
      : authModels.filter((model) =>
          isCredentiallessOpenCodeModel(provider.adapterId, model),
        );
    if (models.length === 0) continue;
    candidates.push(
      Object.freeze({
        adapterId: provider.adapterId,
        models,
      }),
    );
  }

  return Object.freeze(candidates);
}

/**
 * Revalidate a preserved, already-authenticated physical reviewer session.
 * Account cooldown is intentionally irrelevant here: the live PTY is stronger
 * evidence than whether a new account may be leased at this instant.
 */
export function isIndependentCliReviewAdapterAllowed(
  adapterId: string,
  options: { readonly reserveClaude?: boolean } = {},
): boolean {
  if (options.reserveClaude === true && adapterId === 'claude') return false;
  const provider = listProviderSettings().find(
    (candidate) => candidate.adapterId === adapterId,
  );
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.kind !== 'cli-pty'
  ) {
    return false;
  }
  const adapter = getAdapter(adapterId);
  if (
    adapter?.kind !== 'cli-pty' ||
    !isBuiltinAdapter(adapter.id) ||
    !hasPhysicalNexusReviewToolRoute(adapter)
  ) {
    return false;
  }
  if (isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)) return true;
  return (
    adapter.id === 'codex' &&
    supportsEnforceableWorkspaceWriteNativeAuthority(adapter) &&
    supportsEnforceableReadOnlyNativeAuthority(adapter)
  );
}
