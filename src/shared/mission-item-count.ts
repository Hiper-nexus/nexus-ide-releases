/**
 * Conta e extrai itens listados no objetivo civil.
 *
 * Missão com 20 stories numeradas precisa virar 20 tasks no plano/board —
 * não 5 papéis do squad. Pedido em prosa ("exatamente 20 user stories")
 * também sela 20 placeholders. One-liner sem conta nem lista permanece
 * um plano pequeno.
 *
 * Teto alinhado a `nexus_task plan` (64). Isto é o lado plano/board;
 * o leque de writers (PR 87) consome `countMissionItems`.
 */

import { extractStoriesFromPromotedPlanSummary } from './mission-wave-pack';

/** Mesmo teto de `nexus_task plan` / `createPlanAtomically`. */
export const MAX_SEALED_MISSION_ITEMS = 64;

const NUMBERED_ITEM_RE =
  /^\s*(?:(?:\d+|[A-Za-z])[.)]\s+|(?:\d+)\s*[-–—]\s+|#{1,3}\s*Story\s+\d+\.\d+\s*:\s+)/;

const BULLET_ITEM_RE = /^\s*[-*•]\s+\S/;

/**
 * item-01 / US-01 / Story 01 / stories/01.md — o formato que o Maestro
 * e os writers usam quando o civil pede N stories sem listá-las.
 */
const ITEM_01_RE =
  /^\s*(?:(?:item|us|story)[-_ ]|#)?0*\d{1,3}(?:\.md)?\s*[:.)\-–—]\s+\S/i;

const STORY_FILE_RE = /^\s*stories\/0*\d{1,3}(?:\.md)?\b/i;

const STORY_HEADING_RE =
  /^\s*(?:#{1,3}\s*)?(?:Story|História|Item)\s+\d+(?:\.\d+)?\s*:\s+\S/i;

const REQUESTED_STORY_COUNT_RE =
  /\b(?:exatamente|exactly|precisamente)?\s*(\d{1,3})\s+(?:user\s+)?(?:stories|story|hist[oó]rias?(?:\s+de\s+usu[aá]rio)?|entregas?)\b/giu;

const SQUAD_ROLE_TITLE_RE =
  /^(?:maestro|orquestrador|orchestrator|frontend|backend|generalist|full[- ]?stack|ux(?:\s+designer)?|designer|qa|security|reviewer|revisor|escritor|writer)(?:\s*[·•]?\s*\d+)?$/iu;

function stripListMarker(line: string): string {
  return line
    .replace(
      /^\s*(?:(?:item|us|story)[-_ ]|#)?0*\d{1,3}(?:\.md)?\s*[:.)\-–—]\s+/i,
      '',
    )
    .replace(/^\s*stories\/0*\d{1,3}(?:\.md)?\s*[:.)\-–—]?\s*/i, '')
    .replace(
      /^\s*(?:#{1,3}\s*)?(?:Story|História|Item)\s+\d+(?:\.\d+)?\s*:\s+/i,
      '',
    )
    .replace(
      /^\s*(?:(?:\d+|[A-Za-z])[.)]\s+|(?:\d+)\s*[-–—]\s+|[-*•]\s+|#{1,3}\s*Story\s+\d+\.\d+\s*:\s+)/,
      '',
    )
    .trim();
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function collectMarkedItems(
  lines: readonly string[],
  kind: 'numbered' | 'bullet' | 'item-01',
): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const matches =
      kind === 'numbered'
        ? NUMBERED_ITEM_RE.test(line)
        : kind === 'bullet'
          ? BULLET_ITEM_RE.test(line)
          : ITEM_01_RE.test(line) ||
            STORY_FILE_RE.test(line) ||
            STORY_HEADING_RE.test(line);
    if (!matches) continue;
    const title = stripListMarker(line).slice(0, 1_024);
    if (title.length > 0) items.push(title);
    if (items.length >= MAX_SEALED_MISSION_ITEMS) break;
  }
  return items;
}

function looksLikeUnnumberedStoryList(lines: readonly string[]): boolean {
  if (lines.length < 3) return false;
  return lines.every((line) => {
    if (line.length > 200) return false;
    if (line.includes('. ') && line.length > 80) return false;
    return true;
  });
}

/** Título que é papel do squad, não uma entrega. */
export function isSquadRoleTitle(title: string): boolean {
  return SQUAD_ROLE_TITLE_RE.test(title.trim());
}

/**
 * Lista curta cujos títulos são Frontend/Backend/UX/… — o colapso do
 * Maestro em papéis, não as N stories pedidas.
 */
export function listedItemsLookLikeRoleCollapse(
  items: readonly string[],
): boolean {
  if (items.length < 2 || items.length > 8) return false;
  const roles = items.filter((item) => isSquadRoleTitle(item));
  return roles.length >= Math.ceil(items.length * 0.75);
}

/**
 * Conta pedida em prosa ("exatamente 20 user stories"). `null` quando
 * o texto não pede um N explícito de stories/entregas.
 */
export function requestedMissionItemCount(objective: string): number | null {
  const text = String(objective ?? '');
  if (!text.trim()) return null;
  let found: number | null = null;
  REQUESTED_STORY_COUNT_RE.lastIndex = 0;
  for (const match of text.matchAll(REQUESTED_STORY_COUNT_RE)) {
    const count = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isInteger(count) || count < 2) continue;
    const capped = Math.min(count, MAX_SEALED_MISSION_ITEMS);
    if (found === null || capped > found) found = capped;
  }
  return found;
}

export function placeholderMissionItems(count: number): readonly string[] {
  const n = Math.min(
    MAX_SEALED_MISSION_ITEMS,
    Math.max(0, Math.floor(count)),
  );
  return Object.freeze(
    Array.from({ length: n }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, '0');
      return `Story ${ordinal}`;
    }),
  );
}

function preferRequestedOverRoles(
  items: readonly string[],
  requested: number | null,
): readonly string[] | null {
  if (requested === null || requested < 2) return null;
  if (items.length >= requested) return null;
  if (!listedItemsLookLikeRoleCollapse(items)) return null;
  return placeholderMissionItems(requested);
}

/**
 * Extrai as stories/tarefas listadas no objetivo.
 *
 * Ordem: BMAD `Story N.M` → itens numerados → item-01/stories/01 →
 * bullets → linhas curtas independentes (≥3). Colapso em papéis do
 * squad cede à conta pedida em prosa. Sem lista, um N explícito
 * ("20 user stories") vira N placeholders. Sem lista e sem conta,
 * devolve o objetivo inteiro como um item.
 */
export function extractListedMissionItems(
  objective: string,
): readonly string[] {
  const text = String(objective ?? '').trim();
  if (!text) return Object.freeze([]);

  const requested = requestedMissionItemCount(text);

  const bmad = extractStoriesFromPromotedPlanSummary(text)
    .map((story) => story.title.trim())
    .filter((title) => title.length > 0)
    .slice(0, MAX_SEALED_MISSION_ITEMS);
  if (bmad.length >= 2) {
    return Object.freeze(preferRequestedOverRoles(bmad, requested) ?? bmad);
  }

  const lines = nonEmptyLines(text);
  const numbered = collectMarkedItems(lines, 'numbered');
  if (numbered.length >= 2) {
    return Object.freeze(
      preferRequestedOverRoles(numbered, requested) ?? numbered,
    );
  }

  const item01 = collectMarkedItems(lines, 'item-01');
  if (item01.length >= 2) {
    return Object.freeze(preferRequestedOverRoles(item01, requested) ?? item01);
  }

  const bullets = collectMarkedItems(lines, 'bullet');
  if (bullets.length >= 2) {
    return Object.freeze(
      preferRequestedOverRoles(bullets, requested) ?? bullets,
    );
  }

  if (looksLikeUnnumberedStoryList(lines)) {
    const shortLines = lines
      .map((line) => line.slice(0, 1_024))
      .slice(0, MAX_SEALED_MISSION_ITEMS);
    return Object.freeze(
      preferRequestedOverRoles(shortLines, requested) ?? shortLines,
    );
  }

  if (requested !== null && requested >= 2) {
    return placeholderMissionItems(requested);
  }

  return Object.freeze([text.slice(0, 1_024)]);
}

/** Quantos itens o plano/board deve rastrear para este objetivo. */
export function countMissionItems(objective: string): number {
  return extractListedMissionItems(objective).length;
}
