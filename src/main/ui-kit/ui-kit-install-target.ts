import { UI_KIT_IDS, type UiKitId } from './ui-kit-cli';
import { liveCandidates } from './ui-kit-catalog';
import {
  pickUiKit,
  type UiKitCandidate,
  type UiKitPickResult,
} from './ui-kit-pick';
import { boardUiLicenseStatus, type UiKitServiceDeps } from './ui-kit-service';

/**
 * "Install what fits this task" — the Jev's kit/item choice, on the INSTALL
 * surface.
 *
 * It used to hang off `nexus_ui_kit_catalog`, which is classified `read-only`
 * in mcp-effect-policy: that put an HTTP request carrying the task text to a
 * third party, plus a write to the decision log, within reach of a reviewer, a
 * readOnly worker and an unconfirmed voice call. The catalogue now answers
 * with the offline rule and the decision lives here, where the call is already
 * an effect and already gated.
 *
 * Being effectful also makes the answer better than the read-only lane's could
 * be: this may ask the vendor, so the candidates are the LIVE catalogue and
 * the Pro gate runs against the licence as it stands rather than assuming it
 * absent.
 *
 * Without a Jev credential `pickUiKit` returns its own offline heuristic and
 * nothing leaves the machine — a client with no key keeps a wholly classic
 * Nexus, and `source` on the result says which one answered.
 */

/** Candidates handed to the pick, across however many kits are in play. */
const MAX_CANDIDATES = 120;

export interface InstallTargetRequest {
  readonly task: string;
  /** A kit the caller named. Honoured: their choice is not the Jev's to make. */
  readonly kit?: UiKitId | undefined;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
}

export interface InstallTarget {
  readonly kit: UiKitId;
  /** What to install. One item: a task resolves to a component, not a batch. */
  readonly items: readonly string[];
  readonly pick: UiKitPickResult;
}

export type InstallTargetResult =
  | { readonly ok: true; readonly target: InstallTarget; readonly pick: UiKitPickResult }
  | { readonly ok: false; readonly pick: UiKitPickResult };

function kitsToConsider(kit: UiKitId | undefined): readonly UiKitId[] {
  return kit ? [kit] : UI_KIT_IDS;
}

/**
 * Resolve a task to one installable item.
 *
 * `ok: false` carries the pick anyway: "the task needs no component", "the
 * only match is Pro and there is no licence" and "nothing in the catalogue
 * fits" are all answers the caller should relay, not silent failures.
 */
export async function resolveInstallTargetForTask(
  request: InstallTargetRequest,
  deps: UiKitServiceDeps = {},
): Promise<InstallTargetResult> {
  const kits = kitsToConsider(request.kit);

  // Only ask about the licence when BoardUI is actually in play: for a shadcn
  // install it would spawn the vendor's MCP server for nothing.
  const licensed = kits.includes('boardui')
    ? (await boardUiLicenseStatus({ cwd: request.cwd }, deps)).state === 'active'
    : false;

  const candidates: UiKitCandidate[] = [];
  for (const kit of kits) {
    const live = await liveCandidates(kit, request.cwd, undefined, deps);
    candidates.push(...live.candidates);
  }

  const pick = await pickUiKit(
    {
      task: request.task,
      candidates: candidates.slice(0, MAX_CANDIDATES),
      availableKits: kits,
      proLicensed: licensed,
      ...(request.signal ? { signal: request.signal } : {}),
    },
    {},
  );

  if (!pick.needsKit || !pick.item || !pick.kit) {
    return { ok: false, pick };
  }
  return {
    ok: true,
    target: { kit: pick.kit, items: [pick.item.slug], pick },
    pick,
  };
}

/** The pick, as a receipt field. Only ids and the reason — never the task. */
export function installPickReceipt(pick: UiKitPickResult): Record<string, unknown> {
  return {
    decidedBy: pick.source,
    kit: pick.kit,
    item: pick.item?.slug ?? null,
    needsKit: pick.needsKit,
    reason: pick.reason,
    ...(pick.needsLicense ? { needsLicense: true } : {}),
    ...(pick.blockedItem ? { blocked: pick.blockedItem.slug } : {}),
  };
}
