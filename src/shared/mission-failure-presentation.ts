/**
 * Presentation-only parsing of `mission.description` for operator surfaces.
 *
 * The stored description is load-bearing state: technical block notes are
 * appended with HTML-comment markers and `[NEXUS_*]` tokens that recovery
 * policies (`hasAutomaticTechnicalRecovery`, reopen CTAs) match literally.
 * NOTHING here may rewrite the stored value — this module only derives a
 * human-readable projection for rendering.
 */

export interface MissionFailureSection {
  readonly title: string;
  readonly body: string;
}

export interface MissionFailurePresentation {
  /** Operator-authored goal/description with technical notes removed. */
  readonly summary: string;
  /** Human-readable diagnostic sections parsed from appended block notes. */
  readonly sections: readonly MissionFailureSection[];
  /** First actionable line for compact surfaces (rail, board card, toast). */
  readonly headline: string | null;
}

const NEXUS_HTML_COMMENT = /<!--\s*nexus:[\s\S]*?-->/gu;
const ANY_HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const NEXUS_TOKEN = /\[NEXUS_[A-Za-z0-9_:.-]+\]/gu;
const HEADING = /^##[ \t]+(.+?)[ \t]*$/gmu;
const TRAILING_CTA = /(?:^|\s)CTA:\s*[^\n]*$/u;

function firstTechnicalBoundary(description: string): number {
  const candidates: number[] = [];
  const comment = /<!--\s*nexus:/u.exec(description);
  if (comment) candidates.push(comment.index);
  NEXUS_TOKEN.lastIndex = 0;
  const token = NEXUS_TOKEN.exec(description);
  if (token) candidates.push(token.index);
  const heading = /(?:^|\n)##[ \t]+/u.exec(description);
  if (heading) candidates.push(heading.index);
  return candidates.length > 0 ? Math.min(...candidates) : -1;
}

function cleanBody(value: string): string {
  return value
    .replace(ANY_HTML_COMMENT, ' ')
    .replace(NEXUS_TOKEN, ' ')
    .replace(TRAILING_CTA, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function sectionsFrom(technical: string): MissionFailureSection[] {
  const withoutComments = technical.replace(ANY_HTML_COMMENT, '\n');
  const sections: MissionFailureSection[] = [];
  HEADING.lastIndex = 0;
  const headings = [...withoutComments.matchAll(HEADING)];
  const preamble = cleanBody(
    withoutComments.slice(0, headings[0]?.index ?? withoutComments.length),
  );
  if (preamble) sections.push({ title: 'Falha técnica', body: preamble });
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const start = heading.index! + heading[0].length;
    const end = headings[index + 1]?.index ?? withoutComments.length;
    const body = cleanBody(withoutComments.slice(start, end));
    const title = cleanBody(heading[1] ?? '') || 'Falha técnica';
    if (body) sections.push({ title, body });
  }
  return sections;
}

/**
 * Splits a mission description into the operator's own text and readable
 * diagnostic sections. Descriptions without technical notes come back
 * unchanged with zero sections.
 */
export function presentMissionFailure(
  description: string,
): MissionFailurePresentation {
  const normalized = description ?? '';
  const boundary = firstTechnicalBoundary(normalized);
  if (boundary < 0) {
    return Object.freeze({
      summary: normalized.trim(),
      sections: Object.freeze([]),
      headline: null,
    });
  }
  const summary = normalized.slice(0, boundary).trim();
  const sections = sectionsFrom(normalized.slice(boundary));
  const headline = sections[0]?.body.split(/\n/u, 1)[0]?.slice(0, 200) ?? null;
  return Object.freeze({
    summary,
    sections: Object.freeze(sections),
    headline: headline && headline.length > 0 ? headline : null,
  });
}

/** True when the description carries any appended technical note. */
export function hasMissionFailureNotes(description: string): boolean {
  return firstTechnicalBoundary(description ?? '') >= 0;
}

export const __internal = Object.freeze({
  NEXUS_HTML_COMMENT,
  cleanBody,
});
