import { UI_KIT_IDS, type UiKitId } from './ui-kit-cli';
import { liveCandidates } from './ui-kit-catalog';
import {
  pickUiKit,
  searchTermsForTask,
  taskItemAffinity,
  type UiKitCandidate,
  type UiKitPickResult,
} from './ui-kit-pick';
import {
  boardUiProSelectable,
  SHADCN_DEMO_CATEGORY,
  type UiKitServiceDeps,
} from './ui-kit-service';

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

/**
 * Candidates handed to the pick, across however many kits are in play.
 *
 * Note what this is NOT: `pickUiKit` itself keeps only
 * `UI_KIT_PICK_MAX_CANDIDATES` (12) of whatever arrives, so a list that is
 * merely "big enough" is not enough — what matters is that both kits are
 * represented in the first few.
 */
const MAX_CANDIDATES = 120;

/**
 * One list where each kit keeps its place.
 *
 * Concatenating and truncating silently deleted BoardUI: a shadcn search
 * returns up to its 200-item limit, so every slot went to shadcn and a
 * dashboard task could never pick a BoardUI item even though both vendors had
 * been asked. Round-robin keeps the head of the list mixed, which is the part
 * the pick actually sees.
 */
export function interleaveByKit(
  byKit: readonly (readonly UiKitCandidate[])[],
  limit: number,
): readonly UiKitCandidate[] {
  const out: UiKitCandidate[] = [];
  const depth = Math.max(0, ...byKit.map((list) => list.length));
  for (let index = 0; index < depth && out.length < limit; index += 1) {
    for (const list of byKit) {
      const entry = list[index];
      if (entry) out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Order one kit's catalogue by how much it answers the task.
 *
 * Interleaving the kits was not enough: `pickUiKit` keeps only
 * `UI_KIT_PICK_MAX_CANDIDATES` (12), so the head of each list was simply the
 * head of the VENDOR's catalogue — for BoardUI that is `tree-view` through
 * `close-button`, while `stat-cards`, the charts and `data-table` never
 * reached the judge for "build a dashboard".
 *
 * Two passes, because lexical overlap is often zero on a generic task. What
 * matches the task's words comes first; everything else is spread ACROSS
 * CATEGORIES rather than taken in catalogue order, so blocks, templates and
 * primitives are all represented in the first few.
 */
export function rankForTask(
  task: string,
  candidates: readonly UiKitCandidate[],
): readonly UiKitCandidate[] {
  // ONE source for "does this item answer this task": the picker's fallback
  // asks the same question before it trusts the head of this list.
  const score = (candidate: UiKitCandidate): number =>
    taskItemAffinity(task, candidate);

  const matched: UiKitCandidate[] = [];
  const byCategory = new Map<string, UiKitCandidate[]>();
  for (const candidate of candidates) {
    // A demo (`button-demo`, `registry:example`) is not the component: it
    // took scarce slots of the 12 the judge sees.
    if (candidate.category === SHADCN_DEMO_CATEGORY) continue;
    if (score(candidate) > 0) {
      matched.push(candidate);
      continue;
    }
    const bucket = byCategory.get(candidate.category) ?? [];
    bucket.push(candidate);
    byCategory.set(candidate.category, bucket);
  }
  matched.sort((a, b) => score(b) - score(a));

  const spread: UiKitCandidate[] = [];
  const buckets = [...byCategory.values()];
  const depth = Math.max(0, ...buckets.map((bucket) => bucket.length));
  for (let index = 0; index < depth; index += 1) {
    for (const bucket of buckets) {
      const entry = bucket[index];
      if (entry) spread.push(entry);
    }
  }
  return [...matched, ...spread];
}

export interface InstallTargetRequest {
  readonly task: string;
  /** A kit the caller named. Honoured: their choice is not the Jev's to make. */
  readonly kit?: UiKitId | undefined;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  /** The caller, so the decision counts against its own decision budget. */
  readonly sessionId?: string | undefined;
  readonly missionId?: string | undefined;
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
  // install it would spawn the vendor's MCP server for nothing. Asking puts
  // the bundled licence in place first — a fresh machine used to answer "no
  // licence" here and keep the pick on the free half.
  const licensed = kits.includes('boardui')
    ? await boardUiProSelectable({ cwd: request.cwd }, deps)
    : false;

  const taskQueries = searchTermsForTask(request.task);
  const byKit = await Promise.all(
    kits.map(async (kit) => {
      const live = await liveCandidates(kit, request.cwd, undefined, deps, { taskQueries });
      return [...rankForTask(request.task, live.candidates)];
    }),
  );

  const pick = await pickUiKit(
    {
      task: request.task,
      candidates: interleaveByKit(byKit, MAX_CANDIDATES),
      availableKits: kits,
      proLicensed: licensed,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.missionId ? { missionId: request.missionId } : {}),
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
    ...(pick.kitDecidedBy ? { kitDecidedBy: pick.kitDecidedBy } : {}),
    ...(pick.itemDecidedBy !== undefined ? { itemDecidedBy: pick.itemDecidedBy } : {}),
    kit: pick.kit,
    item: pick.item?.slug ?? null,
    needsKit: pick.needsKit,
    reason: pick.reason,
    ...(pick.needsLicense ? { needsLicense: true } : {}),
    ...(pick.blockedItem ? { blocked: pick.blockedItem.slug } : {}),
  };
}
