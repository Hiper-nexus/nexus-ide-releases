/**
 * Schedule ownership: glue fences, intersection, expansion, planner contract.
 * Split from mission-scheduler.ts to keep the decision core under the line cap.
 */

import {
  READ_ONLY_SURFACE_DOMAIN,
  claimOwnershipDomains,
  type WorktreeOwnership,
} from '../runtime/worktree-contract';
import { WAVE_PACK_DISJOINT_FILES_DOMAIN } from '../../shared/mission-wave-pack';

export interface ScheduleOwnership {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly domains: readonly string[];
}

/**
 * Paths / path prefixes that must never be owned by a parallel wave member.
 */
export const RESERVED_GLUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^package-lock\.json$/i,
  /^npm-shrinkwrap\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^bun\.lockb?$/i,
  /^Cargo\.lock$/i,
  /^Gemfile\.lock$/i,
  /^poetry\.lock$/i,
  /^composer\.lock$/i,
  /^go\.sum$/i,
  /(^|\/)index\.ts$/i,
  /(^|\/)index\.tsx$/i,
  /(^|\/)index\.js$/i,
  /(^|\/)index\.mjs$/i,
  /(^|\/)index\.cjs$/i,
  /(^|\/)__init__\.py$/i,
  /(^|\/)migrations?\//i,
  /^\.nexus(\/|$)/i,
  /^\.context(\/|$)/i,
  /^\.nexus-memory(\/|$)/i,
]);

export function normalizeSchedulePath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isReservedGlueFile(file: string): boolean {
  const normalized = normalizeSchedulePath(file);
  return RESERVED_GLUE_PATTERNS.some((re) => re.test(normalized));
}

export function ownershipTouchesReservedGlue(
  ownership: ScheduleOwnership,
): boolean {
  return ownership.files.some(isReservedGlueFile);
}

/**
 * Tasks that must never share a wave: reserved glue, empty ownership
 * (cannot prove disjointness), or explicit sequential-only domain.
 *
 * Guided kind labels alone do not count as claim surface — empty files +
 * `guided-advisory` stays parallel-eligible. Callers that need exclusive
 * empty-file tasks must attach `sequential-only`.
 */
export function requiresExclusiveSlot(ownership: ScheduleOwnership): boolean {
  if (ownershipTouchesReservedGlue(ownership)) return true;
  if (ownership.domains.some((d) => d.toLowerCase() === 'sequential-only')) {
    return true;
  }
  const claims =
    ownership.files.length +
    ownership.symbols.length +
    claimOwnershipDomains(ownership.domains).length;
  // Empty files with only kind labels: not exclusive (parallel tips).
  // Truly empty ownership (no files/symbols/claim domains and no kind label):
  // exclusive — cannot prove disjointness.
  if (claims === 0 && ownership.domains.length === 0) return true;
  return false;
}

export function toWorktreeOwnership(
  ownership: ScheduleOwnership,
): WorktreeOwnership {
  return Object.freeze({
    files: Object.freeze([...ownership.files.map(normalizeSchedulePath)]),
    symbols: Object.freeze([...ownership.symbols]),
    domains: Object.freeze(
      ownership.domains.map((d) => d.toLocaleLowerCase('en-US')),
    ),
  });
}

export function ownershipsIntersect(
  left: ScheduleOwnership,
  right: ScheduleOwnership,
): boolean {
  const leftFiles = left.files.map(normalizeSchedulePath);
  const rightFiles = right.files.map(normalizeSchedulePath);
  const bothWavePack =
    left.domains.some(
      (domain) => domain.toLocaleLowerCase('en-US') === 'wave-pack',
    ) &&
    right.domains.some(
      (domain) => domain.toLocaleLowerCase('en-US') === 'wave-pack',
    );
  // A disjoint-file story owns a real file subset, so its file overlap is
  // authoritative — two such stories fan out only when their files truly do
  // not intersect. Legacy shared-inventory stories still fall back to the
  // merge-permit shortcut (exclusivity via wave-pack-story:<id> + symbols).
  const bothDisjointFiles =
    left.domains.some(
      (domain) =>
        domain.toLocaleLowerCase('en-US') === WAVE_PACK_DISJOINT_FILES_DOMAIN,
    ) &&
    right.domains.some(
      (domain) =>
        domain.toLocaleLowerCase('en-US') === WAVE_PACK_DISJOINT_FILES_DOMAIN,
    );
  // Pack stories share inventory files as merge permit; wave exclusivity is
  // wave-pack-story:<id> (+ symbols). See docs/design/mission-wave-pack.md.
  const fileOverlap =
    bothWavePack && !bothDisjointFiles
      ? false
      : leftFiles.some((leftFile) =>
          rightFiles.some((rightFile) =>
            fileClaimsOverlap(leftFile, rightFile),
          ),
        );
  const exactOverlap = (a: readonly string[], b: readonly string[]) => {
    const rightValues = new Set(b);
    return a.some((value) => rightValues.has(value));
  };
  const leftClaimDomains = claimOwnershipDomains(left.domains).map((d) =>
    d.toLocaleLowerCase('en-US'),
  );
  const rightClaimDomains = claimOwnershipDomains(right.domains).map((d) =>
    d.toLocaleLowerCase('en-US'),
  );
  return (
    fileOverlap ||
    exactOverlap(left.symbols, right.symbols) ||
    exactOverlap(leftClaimDomains, rightClaimDomains)
  );
}

function fileClaimsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/+$/, '');
  const normalizedRight = right.replace(/\/+$/, '');
  if (normalizedLeft === normalizedRight) return true;
  return (
    (isDirectoryClaim(normalizedLeft) &&
      normalizedRight.startsWith(`${normalizedLeft}/`)) ||
    (isDirectoryClaim(normalizedRight) &&
      normalizedLeft.startsWith(`${normalizedRight}/`))
  );
}

function isDirectoryClaim(file: string): boolean {
  const basename = file.split('/').pop() ?? file;
  return file.endsWith('/') || !basename.includes('.');
}

/**
 * Expand ownership with a pure file-set expander (blast-radius adapter).
 * When expander is omitted, ownership is used as-is.
 */
export function expandScheduleOwnership(
  ownership: ScheduleOwnership,
  expandFiles?: (files: readonly string[]) => readonly string[],
): ScheduleOwnership {
  if (!expandFiles || ownership.files.length === 0) {
    return Object.freeze({
      files: Object.freeze(ownership.files.map(normalizeSchedulePath)),
      symbols: Object.freeze([...ownership.symbols]),
      domains: Object.freeze([...ownership.domains]),
    });
  }
  const expanded = expandFiles(ownership.files.map(normalizeSchedulePath));
  const files = [
    ...new Set([
      ...ownership.files.map(normalizeSchedulePath),
      ...expanded.map(normalizeSchedulePath),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return Object.freeze({
    files: Object.freeze(files),
    symbols: Object.freeze([...ownership.symbols]),
    domains: Object.freeze([...ownership.domains]),
  });
}

export interface OwnershipEnforcementResult {
  readonly ok: boolean;
  readonly undeclaredFiles: readonly string[];
  readonly reason: string;
}

/**
 * Every changed path must fall within expanded ownership files.
 */
export function enforceOwnershipOnDiff(
  changedFiles: readonly string[],
  ownership: ScheduleOwnership,
  expandFiles?: (files: readonly string[]) => readonly string[],
): OwnershipEnforcementResult {
  const expanded = expandScheduleOwnership(ownership, expandFiles);
  const owned = new Set(expanded.files.map(normalizeSchedulePath));
  const undeclared: string[] = [];
  for (const raw of changedFiles) {
    const file = normalizeSchedulePath(raw);
    if (owned.has(file)) continue;
    const underDir = [...owned].some((claim) => {
      if (claim.endsWith('/')) {
        return file.startsWith(claim) || file === claim.slice(0, -1);
      }
      const base = claim.split('/').pop() ?? claim;
      const looksLikeFile = base.includes('.');
      if (looksLikeFile) return false;
      return file === claim || file.startsWith(`${claim}/`);
    });
    if (underDir) continue;
    undeclared.push(file);
  }
  if (undeclared.length > 0) {
    return {
      ok: false,
      undeclaredFiles: Object.freeze(undeclared.sort()),
      reason: `out-of-scope changes: ${undeclared.join(', ')}`,
    };
  }
  return {
    ok: true,
    undeclaredFiles: Object.freeze([]),
    reason: 'within ownership',
  };
}

export interface PlannerTaskInput {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly ownership?: ScheduleOwnership;
  readonly dependsOn?: readonly string[];
  /**
   * `read_only` marks a READER (QA, review, advisory): it writes nothing, so
   * empty ownership means "touches nothing" and must not claim an exclusive
   * slot. Omitted → treated as a writer, which stays fail-closed.
   */
  readonly executionMode?: string;
}

export interface PlannedScheduleTask {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly dependsOn: readonly string[];
  readonly ownership: ScheduleOwnership;
  /** True when ownership was confidently declared (eligible for parallel). */
  readonly parallelEligible: boolean;
}

/**
 * Empty-file tasks are parallel-safe when they carry a non-sequential domain
 * label (read-only guided advisors). Mutating empty ownership still forces the
 * sequential chain — disjointness cannot be proven.
 *
 * `executionMode` closes the inversion this rule used to carry: for a READER,
 * empty ownership means "touches nothing", not "touches everything". Using a
 * domain label as a proxy for read-only made every unlabelled verification unit
 * (QA, senior review) take an EXCLUSIVE slot and serialize against its peers —
 * the HiperGO 06/08 case, where two non-writing units cost two waves instead of
 * one. A writer with empty ownership stays fail-closed: nothing to prove
 * disjointness against.
 */
export function ownershipDeclaresParallelSurface(
  ownership: ScheduleOwnership | undefined,
  executionMode?: string,
): boolean {
  if (!ownership) return false;
  // An EXPLICIT sequential-only is honoured even for a reader: a gate that
  // wants a quiescent tree is a legitimate request, not an accident.
  if (ownership.domains.some((d) => d.toLowerCase() === 'sequential-only')) {
    return false;
  }
  if (ownershipTouchesReservedGlue(ownership)) return false;
  if (ownership.files.length > 0) return true;
  // A reader writes nothing, so it can never collide — label or no label.
  if (executionMode === 'read_only') return true;
  // Empty files: parallel-safe when a non-sequential domain label is present
  // (read-only guided advisors / reviewers).
  return ownership.domains.length > 0;
}

/**
 * Ensure every planned task carries dependsOn + ownership.
 *
 * Per-task eligibility: a glue/exclusive sibling must not rewrite tip roots
 * (`dependsOn: []`) into a sequential chain. Explicit `dependsOn` (including
 * empty arrays) is always preserved; auto-chain only when `dependsOn` is
 * omitted and the task cannot declare a parallel surface.
 */
export function emitPlannedTasksWithContract(
  inputs: readonly PlannerTaskInput[],
): readonly PlannedScheduleTask[] {
  if (inputs.length === 0) return Object.freeze([]);

  return Object.freeze(
    inputs.map((input, index) => {
      const baseOwnership: ScheduleOwnership = input.ownership ?? {
        files: Object.freeze([]),
        symbols: Object.freeze([]),
        domains: Object.freeze(['sequential-only']),
      };

      let domains = [...(baseOwnership.domains ?? [])];
      const parallelEligible = ownershipDeclaresParallelSurface(
        baseOwnership,
        input.executionMode,
      );
      // Leitor sem arquivos: carimba a marca POSITIVA de leitor. Ownership
      // deixa de ser vazia (portanto não exclusiva) sem virar reivindicação,
      // então dois leitores dividem a mesma onda.
      // Carimba SOMENTE quando a ownership é totalmente vazia — nenhum domínio.
      // Uma unidade que já traz rótulo (`guided-advisory`, `guided-quality-gate`,
      // `sequential-only`…) já tinha seu comportamento decidido por ele, então o
      // marcador seria redundante — e mexer na lista de domínios de um plano
      // selado é caro: o selo compara ownership byte a byte (foi assim que dois
      // testes de guided-planner quebraram na primeira versão desta correção).
      if (
        input.executionMode === 'read_only' &&
        baseOwnership.files.length === 0 &&
        baseOwnership.symbols.length === 0 &&
        domains.length === 0
      ) {
        domains = [...domains, READ_ONLY_SURFACE_DOMAIN];
      }
      if (
        !parallelEligible &&
        input.executionMode !== 'read_only' &&
        baseOwnership.files.length === 0 &&
        baseOwnership.symbols.length === 0 &&
        !domains.some((d) => d.toLowerCase() === 'sequential-only')
      ) {
        domains = [...domains, 'sequential-only'];
      }

      const ownership: ScheduleOwnership = Object.freeze({
        files: Object.freeze(baseOwnership.files.map(normalizeSchedulePath)),
        symbols: Object.freeze([...(baseOwnership.symbols ?? [])]),
        domains: Object.freeze(domains),
      });

      let dependsOn: readonly string[];
      if (input.dependsOn !== undefined) {
        dependsOn = input.dependsOn;
      } else if (
        !ownershipDeclaresParallelSurface(ownership, input.executionMode) &&
        index > 0
      ) {
        dependsOn = Object.freeze([inputs[index - 1]!.id]);
      } else {
        dependsOn = Object.freeze([]);
      }

      return Object.freeze({
        id: input.id,
        title: input.title,
        detail: input.detail ?? '',
        dependsOn: Object.freeze([...dependsOn]),
        ownership,
        parallelEligible: ownershipDeclaresParallelSurface(ownership),
      });
    }),
  );
}

export function independentSubsetTaskIds(
  planned: readonly PlannedScheduleTask[],
): readonly string[] {
  return Object.freeze(
    planned.filter((t) => t.parallelEligible).map((t) => t.id),
  );
}

export function expandOwnershipTable(
  tasks: readonly { readonly id: string; readonly ownership: ScheduleOwnership }[],
  expandFiles?: (files: readonly string[]) => readonly string[],
): ReadonlyMap<string, ScheduleOwnership> {
  const map = new Map<string, ScheduleOwnership>();
  for (const task of tasks) {
    map.set(task.id, expandScheduleOwnership(task.ownership, expandFiles));
  }
  return map;
}
