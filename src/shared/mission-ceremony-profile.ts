/**
 * Completion ceremony profile — pure, zero I/O.
 *
 * The completion ceremony used to scale by ONE axis, the mission lane
 * (`mission-code-completion.ts`): a CSS tweak and a payments refactor, both
 * `standard`, paid the same compiler run. This profile adds a second axis
 * without touching the lane (F-810: the free-text classifier must never pick
 * the lane again):
 *
 *   - `workKind` comes from `classifyWorkKind` on the mission goal. It LABELS
 *     the profile so the receipt says which kind of work paid which ceremony.
 *     Text is a weak signal: it never subtracts a check on its own.
 *   - `diffClass` comes from the COMPLETE candidate (changed, deleted, unread
 *     and absent paths). It is the only thing that subtracts, and only when
 *     every path is a style, prose or static asset the compiler never reads.
 *
 * Anything else — one code file, a deleted module, JSON, HTML, MDX, plain
 * text that may be a fixture, an empty or unknown diff — keeps the full
 * ceremony.
 */

import { classifyWorkKind, type WorkKind } from './mission-work-kind';

export type CeremonyDiffClass = 'code' | 'non-executable';

/** A check the diff cannot affect, dropped from the completion ceremony. */
export type CeremonyDroppedCheck = 'typecheck';

export interface MissionCeremonyProfile {
  readonly workKind: WorkKind;
  readonly diffClass: CeremonyDiffClass;
  readonly dropped: readonly CeremonyDroppedCheck[];
}

/**
 * Styles, prose and static assets. Deliberately excluded: `.mdx` (compiles to
 * JSX), `.html` (scripts, build entry), `.json`/`.txt` (imported by code,
 * fixtures, `requirements.txt`) and every config format.
 */
const NON_EXECUTABLE_PATH_RE =
  /\.(?:css|scss|sass|less|styl|md|rst|adoc|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/iu;

export function isNonExecutableDiffPath(file: string): boolean {
  return NON_EXECUTABLE_PATH_RE.test(file);
}

/** Unknown or empty diffs are `code`: absence of a diff is not proof of anything. */
export function classifyCeremonyDiff(paths: readonly string[] | undefined): CeremonyDiffClass {
  if (!paths || paths.length === 0) return 'code';
  return paths.every(isNonExecutableDiffPath) ? 'non-executable' : 'code';
}

export function missionCeremonyProfile(goal: string, diffClass: CeremonyDiffClass): MissionCeremonyProfile {
  return Object.freeze({
    workKind: classifyWorkKind(goal).kind,
    diffClass,
    dropped: Object.freeze(diffClass === 'non-executable' ? ['typecheck' as const] : []),
  });
}

/** One pt-BR line for the completion receipt; empty when the full ceremony ran. */
export function ceremonyProfileNote(profile: MissionCeremonyProfile): string {
  if (profile.dropped.length === 0) return '';
  return `Perfil de cerimônia: trabalho ${profile.workKind}, diff só com estilos, texto ou assets estáticos — typecheck dispensado (o compilador não lê esses arquivos).`;
}
