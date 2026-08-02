import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  decideDesignAuthority,
  type WorkKindVerdict,
} from '../../shared/mission-work-kind';
import {
  designContractSkipReasonForRefusal,
  type DesignContractBuildSkipReason,
} from '../../shared/design-contract-policy';
import {
  createLocalDesignKitSource,
  listLocalDesignCatalog,
  resolveLocalDesignCatalogDir,
} from '../design/local-design-catalog';
import {
  selectDesignDirection,
  type DesignDirectionChoice,
} from '../design/design-kit-selection';
import { renderHouseDesignContract } from '../design/house-design-contract';
import {
  probeProjectDesignSystem,
  renderProjectDerivedDesignContract,
  type ProjectDesignSystemProbe,
} from '../design/project-design-system';
import {
  DEFAULT_DESIGN_TARGET_PATH,
  findExistingDesignContractInScope,
} from '../orch/design-system-authority';
import { homeRelativePath } from '../orch/home-relative-path';
import { openWorkspaceFileForRead } from '../orch/workspace-file';
import type { BootstrapDocProposal } from './orientation/orientation-bootstrap-context';

/**
 * THE DESIGN BRANCH OF THE BOOTSTRAP AUTOPILOT.
 *
 * The gap this closes: `.context/nexus/sensors/design-system-sensor.mjs`
 * already exits 1 when a project has no DESIGN.md, and the contract compiler
 * already makes that sensor required for UI missions — but nothing anywhere
 * turned that red into a contract. The only pilot that proposes drafts with no
 * human in the loop is the context bootstrap autopilot, and it had no design
 * branch. So a UI mission would start, write CSS, and only then discover it
 * had no authority to write it against.
 *
 * This module answers one question, deterministically: *given this scope and
 * this goal, what design contract (if any) should be proposed right now?*
 *
 * Four gates, all fail-closed:
 *   1. `decideDesignAuthority` (src/shared/mission-work-kind.ts) must say yes.
 *      That is the ONE predicate: the contract compiler calls it to require the
 *      `design-system` sensor, `planGuidedWorkGraph` calls it before letting a
 *      task demand a contract with `design_contract_missing`, and this pilot
 *      calls it before writing one. Two copies of this rule is what produced a
 *      deadlock on "trocar a cor do botão de aprovar": no contract created,
 *      executor ordered to block for the lack of one.
 *   2. The workspace must have NO contract yet. An existing DESIGN.md or
 *      `.context/docs/design-system.md` is authority and is never overwritten.
 *   3. A real workspace file must be bindable as evidence. No source, no
 *      proposal: a context draft that cannot hash its evidence is not a draft.
 *   4. The rendered contract must be reproducible from these inputs alone,
 *      because the reviewer's whole method is byte-exact re-derivation.
 *
 * WHICH contract gets written is decided AFTER those gates, and it is not
 * always the house floor: a project that already declares its own tokens gets
 * a contract DERIVED from them (see `probeProjectDesignSystem`). Imposing the
 * house vocabulary on such a project turned the design sensor permanently red
 * and demanded the whole app be re-tokenized — for a mission that asked to
 * change one colour.
 */

export const DESIGN_CONTRACT_TARGET_PATH = DEFAULT_DESIGN_TARGET_PATH;

/**
 * Evidence candidates in priority order. `package.json` first because it is
 * the only one that supports a concrete claim (the project name); the product
 * docs are the fallback identity binding for non-Node repositories.
 */
export const DESIGN_CONTRACT_BINDABLE_SOURCES = Object.freeze([
  'package.json',
  'PRODUCT.md',
  'README.md',
] as const);

const BINDABLE_SOURCES = DESIGN_CONTRACT_BINDABLE_SOURCES;

/** Kept as a local alias so existing importers do not have to move. */
export type DesignContractSkipReason = DesignContractBuildSkipReason;

/** Which document the pilot decided to write, once the gates opened. */
export type DesignContractKind =
  /** Nexus house token floor (the project had no vocabulary of its own). */
  | 'house-floor'
  /** Derived from the tokens this project already declares. */
  | 'project-derived';

export interface DesignContractBootstrapDecision {
  readonly proposal: BootstrapDocProposal | null;
  readonly skipReason: DesignContractSkipReason | null;
  /**
   * Kit direction, present only on the house-floor path. A project with its own
   * design system is never pointed at a third-party brand, so this stays null
   * for `project-derived`.
   */
  readonly choice: DesignDirectionChoice | null;
  readonly contractKind: DesignContractKind | null;
  /** The project's own design system, when one was detected. */
  readonly projectDesignSystem: ProjectDesignSystemProbe | null;
  readonly workKind: WorkKindVerdict | null;
  /** Path that already holds a contract, when that is why we skipped. */
  readonly existingContractPath: string | null;
  /** Mission-facing sentence for the autopilot hint; null when nothing was built. */
  readonly hint: string | null;
}

export interface DesignContractBootstrapInput {
  readonly scope: ProjectExecutionScope;
  /** Mission goal; null/empty means "cannot classify", which skips. */
  readonly goal: string | null;
  /** `orch.designDefaultKit`. */
  readonly pinnedKitId?: string | null;
  /** Resolved `orch.designLocalCatalogDir`; empty uses the home convention. */
  readonly catalogDir?: string | null;
  readonly targetPath?: string;
}

function skip(
  reason: DesignContractSkipReason,
  extra: {
    readonly workKind?: WorkKindVerdict;
    readonly existingContractPath?: string;
  } = {},
): DesignContractBootstrapDecision {
  return Object.freeze({
    proposal: null,
    skipReason: reason,
    choice: null,
    contractKind: null,
    projectDesignSystem: null,
    workKind: extra.workKind ?? null,
    existingContractPath: extra.existingContractPath ?? null,
    hint: null,
  });
}

/**
 * Byte-identical to the hashing `context-knowledge-service.verifySources`
 * performs, so a source hash computed here can never disagree with the one the
 * store recomputes at propose/review/apply time.
 */
function workspaceSourceHash(
  scope: ProjectExecutionScope,
  relativePath: string,
): string | null {
  let handle: ReturnType<typeof openWorkspaceFileForRead>;
  try {
    handle = openWorkspaceFileForRead(scope, relativePath);
  } catch {
    return null;
  }
  try {
    const content = fs.readFileSync(handle.fd);
    if (content.includes(0)) return null;
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  } finally {
    handle.close();
  }
}

function readProjectName(scope: ProjectExecutionScope): string | null {
  try {
    const handle = openWorkspaceFileForRead(scope, 'package.json');
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(
        fs.readFileSync(handle.fd),
      );
      const parsed: unknown = JSON.parse(raw);
      const name =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { name?: unknown }).name
          : undefined;
      return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    } finally {
      handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Build the contract proposal for this scope+goal, or explain why not.
 *
 * Deterministic given the filesystem: called twice with no intervening change,
 * it returns byte-identical content. That property is the entire basis of the
 * independent mechanical review in the autopilot.
 */
export async function buildDesignContractBootstrap(
  input: DesignContractBootstrapInput,
): Promise<DesignContractBootstrapDecision> {
  const goal = (input.goal ?? '').trim();
  if (goal === '') return skip('no-goal');

  // ONE predicate for "does this mission deserve design authority?", shared
  // verbatim with the contract compiler that REQUIRES the `design-system`
  // sensor and with the work graph that decides whether a task may DEMAND a
  // contract. A second copy of this rule is exactly what deadlocked "trocar a
  // cor do botão de aprovar".
  const authority = decideDesignAuthority(goal);
  const workKind = authority.verdict;
  if (!authority.required) {
    return skip(designContractSkipReasonForRefusal(authority.refusal!), {
      workKind,
    });
  }

  const targetPath = input.targetPath ?? DESIGN_CONTRACT_TARGET_PATH;
  const existingContractPath = findExistingDesignContractInScope(
    input.scope,
    targetPath,
  );
  if (existingContractPath) {
    return skip('contract-exists', { workKind, existingContractPath });
  }

  let boundSource: { locator: string; sourceHash: string } | null = null;
  for (const candidate of BINDABLE_SOURCES) {
    const sourceHash = workspaceSourceHash(input.scope, candidate);
    if (sourceHash) {
      boundSource = { locator: candidate, sourceHash };
      break;
    }
  }
  if (!boundSource) return skip('no-bindable-source', { workKind });

  const projectName =
    boundSource.locator === 'package.json' ? readProjectName(input.scope) : null;

  // A project that already speaks a design vocabulary does not get issued a
  // second one. Its own tokens ARE the contract; the house floor is only for
  // repositories that have nothing to be held to.
  const projectDesignSystem = probeProjectDesignSystem(input.scope);
  if (projectDesignSystem) {
    const tokenSourceHash = projectDesignSystem.tokenSourceLocator
      ? workspaceSourceHash(
          input.scope,
          projectDesignSystem.tokenSourceLocator,
        )
      : null;
    const derivedContent = renderProjectDerivedDesignContract({
      projectName,
      probe: projectDesignSystem,
      tokenSourceHash,
      boundSourceLocator: boundSource.locator,
    });
    // The token file joins the bound sources only when it hashed cleanly:
    // an unhashable source would fail `verifySources` at apply time and turn
    // a correct contract into a permanent rejection.
    const sources = [
      Object.freeze({
        type: 'file' as const,
        locator: boundSource.locator,
        sourceHash: boundSource.sourceHash,
      }),
      ...(projectDesignSystem.tokenSourceLocator && tokenSourceHash
        ? [
            Object.freeze({
              type: 'file' as const,
              locator: projectDesignSystem.tokenSourceLocator,
              sourceHash: tokenSourceHash,
            }),
          ]
        : []),
    ];
    return Object.freeze({
      proposal: Object.freeze({
        targetPath,
        content: derivedContent,
        sources: Object.freeze(sources),
        rationale: derivedContractRationale(projectDesignSystem),
      }) as BootstrapDocProposal,
      skipReason: null,
      choice: null,
      contractKind: 'project-derived' as const,
      projectDesignSystem,
      workKind,
      existingContractPath: null,
      hint: derivedContractHint(targetPath, projectDesignSystem),
    });
  }

  // (b) Direction rule: pinned setting → signal match → neutral house.
  // Only the offline catalog participates: the bootstrap pilot must be
  // deterministic and must not spawn npx or reach the network to decide what a
  // project looks like.
  const catalogDir = resolveLocalDesignCatalogDir(input.catalogDir);
  const catalog = listLocalDesignCatalog({ dir: catalogDir });
  const choice = selectDesignDirection({
    goal,
    pinnedKitId: input.pinnedKitId ?? null,
    kits: catalog.kits,
  });

  // The kit's bytes never enter the contract; its hash does, so the reference
  // named in the document is bound to an exact file revision.
  let kitContentHash: string | null = null;
  if (choice.mode !== 'neutral') {
    try {
      const kit = await createLocalDesignKitSource({ dir: catalogDir }).getKit(
        choice.kit.kitId,
      );
      kitContentHash = kit.contentHash;
    } catch {
      kitContentHash = null;
    }
  }

  const content = renderHouseDesignContract({
    projectName,
    choice,
    // This document is APPLIED and COMMITTED. An absolute catalog path would
    // carry the operator's OS account name into the repository history and
    // into every clone; `~/.design-references/<kit>.md` is the same
    // decision-relevant fact without the identity. Determinism is preserved:
    // proposer and mechanical reviewer take this exact code path.
    catalogDir: homeRelativePath(catalogDir),
    kitContentHash,
    boundSourceLocator: boundSource.locator,
  });

  return Object.freeze({
    proposal: Object.freeze({
      targetPath,
      content,
      sources: Object.freeze([
        Object.freeze({
          type: 'file' as const,
          locator: boundSource.locator,
          sourceHash: boundSource.sourceHash,
        }),
      ]),
      rationale: designContractRationale(choice),
    }) as BootstrapDocProposal,
    skipReason: null,
    choice,
    contractKind: 'house-floor' as const,
    projectDesignSystem: null,
    workKind,
    existingContractPath: null,
    hint: designContractHint(targetPath, choice),
  });
}

/**
 * Why a NEUTRAL contract is neutral, in a sentence a human can act on.
 *
 * The previous text interpolated the raw enum — "Neutral house design contract
 * (`ambiguous-match`)" — which reads as a status code, not as a reason, and
 * tells the operator nothing about what to do next.
 */
const NEUTRAL_RATIONALE: Readonly<
  Record<Extract<DesignDirectionChoice, { mode: 'neutral' }>['reason'], string>
> = Object.freeze({
  'empty-catalog':
    'no visual reference was available to choose from (the local design ' +
    'catalog is empty or absent)',
  'pinned-kit-unavailable':
    'the kit pinned in orch.designDefaultKit is not in this catalog, and ' +
    'Nexus will not substitute a different brand for the one a human chose',
  'no-domain-signal':
    'the goal names no product domain that any catalogued reference claims',
  'ambiguous-match':
    'two or more references matched the goal equally well, and a tie is not ' +
    'a direction',
});

export function designContractRationale(choice: DesignDirectionChoice): string {
  if (choice.mode === 'setting') {
    return `House design contract pinned to \`${choice.kit.kitId}\` by orch.designDefaultKit`;
  }
  if (choice.mode === 'match') {
    return (
      `House design contract pointing at \`${choice.kit.kitId}\` — matched on ` +
      `${choice.sharedAxes.join(', ')} (${choice.confidence} confidence)`
    );
  }
  return (
    'House design contract with no visual direction, because ' +
    `${NEUTRAL_RATIONALE[choice.reason]}. The token floor is a baseline to ` +
    'raise, not the design.'
  );
}

export function derivedContractRationale(
  probe: ProjectDesignSystemProbe,
): string {
  return probe.tokenSourceLocator
    ? `Design contract derived from this project's own ${probe.tokens.length} ` +
        `global tokens in \`${probe.tokenSourceLocator}\` — no house floor and ` +
        'no third-party reference imposed'
    : `Design contract pointing at this project's own Tailwind configuration ` +
        `\`${probe.tailwindConfigLocator}\` — no house floor and no ` +
        'third-party reference imposed';
}

/**
 * Mission-facing sentence when the contract describes the project's OWN system.
 * It leads with the prohibition that matters: the mission was asked to change
 * something, not to migrate the product onto a new vocabulary.
 */
export function derivedContractHint(
  targetPath: string,
  probe: ProjectDesignSystemProbe,
): string {
  const authority =
    probe.tokenSourceLocator ?? probe.tailwindConfigLocator ?? 'the project';
  return (
    `Design contract materialized at ${targetPath}, DERIVED from this ` +
    `project's own design system (\`${authority}\`) — no house token floor ` +
    'and no third-party reference were imposed. Consume those tokens by name ' +
    'and extend them if you must; re-tokenizing the product into a new ' +
    'vocabulary is a regression, not a design task.'
  );
}

/**
 * Mission-facing sentence for the autopilot hint. It always states HOW the
 * direction was chosen, because a direction the operator cannot audit is a
 * direction that will be defended by every later task without anyone
 * remembering why.
 */
export function designContractHint(
  targetPath: string,
  choice: DesignDirectionChoice,
): string {
  if (choice.mode === 'setting') {
    return (
      `Design contract materialized at ${targetPath}, pinned to the ` +
      `\`${choice.kit.kitId}\` reference by orch.designDefaultKit. Read that ` +
      'reference and ADAPT it; never copy a third-party brand.'
    );
  }
  if (choice.mode === 'match') {
    return (
      `Design contract materialized at ${targetPath}, pointing at the ` +
      `\`${choice.kit.kitId}\` reference matched on ${choice.sharedAxes.join(', ')} ` +
      `(${choice.confidence} confidence — a heuristic, not an operator ` +
      'decision). Confirm the direction before it hardens, then ADAPT it.'
    );
  }
  return (
    `Neutral design contract materialized at ${targetPath}: no visual ` +
    `direction was chosen because ${NEUTRAL_RATIONALE[choice.reason]}. What ` +
    'landed is a conservative token floor with no third-party brand. ' +
    'Establish a real direction before building UI — the floor is not the ' +
    'design.'
  );
}
