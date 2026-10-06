import { modelLineOf } from '../../shared/model-line';
import type { MissionReviewVerdict } from './mission-review-verdict-ledger';

export type RoutingPurpose = 'general' | 'writer' | 'reviewer' | 'finding-fix';
const WRITE_ACTION = /\b(?:implement(?:ar|e|ing)?|build|add|adicion(?:ar|e)|criar|crie|corrig(?:ir|e|a)|corrij[ae]|fix|refactor|refator(?:ar|e)|atualiz(?:ar|e)|update|modific(?:ar|ue)|change|write|escrev(?:er|a))\b/i;
const WRITE_LEADING = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)?(?:(?:por favor|please|quero que|preciso que|faça|faca)\\s+)?${WRITE_ACTION.source}`, 'i');
const READ_ONLY = /\bread[ -]only\b|\bsomente leitura\b|\bdo not (?:write|change|modify)\b|\bn[aã]o (?:altere|modifique|escreva)\b/i;
const FIX_ACTION = /\b(?:corrig(?:ir|e|a)|corrij[ae]|fix|repair|resolv(?:er|a|e))\b/i;
const FILE_REFERENCE_SOURCE = String.raw`(?:[\w.-]+/)*[\w.-]+\.[a-z][a-z0-9]*(?::\d+)?`;
const REVIEW_REFERENCE_SOURCE = String.raw`\bF-\d+\b|` + FILE_REFERENCE_SOURCE;
const FINDING_REFERENCE = new RegExp(String.raw`\b(?:achados?|findings?)\b|` + REVIEW_REFERENCE_SOURCE, 'i');

/** Purpose affects cost preference only; it never grants execution authority. */
export function routingPurpose(task: string, codeReview: boolean, reviewedFindingFix = false): RoutingPurpose {
  const writes = WRITE_ACTION.test(task) && !READ_ONLY.test(task) &&
    (!codeReview || WRITE_LEADING.test(task));
  if (writes && reviewedFindingFix) return 'finding-fix';
  if (writes) return 'writer';
  return codeReview ? 'reviewer' : 'general';
}

export function isFindingCorrectionTask(task: string): boolean {
  return FIX_ACTION.test(task) && !READ_ONLY.test(task) && FINDING_REFERENCE.test(task);
}

export function isAstraModel(adapterId: string, model: string | undefined): boolean {
  return adapterId === 'codex' && model !== undefined &&
    modelLineOf(model).stem === modelLineOf('gpt-6-astra').stem;
}

/** Only an exact HEAD, clean-tree, frontier rejection identifies a reviewed fix. */
export function matchesReviewedFinding(task: string, verdict: MissionReviewVerdict | null | undefined,
  missionId: string, headSha: string): boolean {
  if (!isFindingCorrectionTask(task) || !verdict || verdict.missionId !== missionId ||
      verdict.headSha !== headSha || verdict.treeDirty || verdict.verdict !== 'reject' || !verdict.frontier) return false;
  return taskReferencesReviewedFindings(task, verdict.findings);
}

/** Reference matching only. The caller must prove the review's Main authority. */
export function taskReferencesReviewedFindings(task: string, findings: readonly string[]): boolean {
  if (!isFindingCorrectionTask(task)) return false;
  const normalizedTask = task.replaceAll('\\', '/');
  return findings.some(finding => {
    const references = finding.replaceAll('\\', '/').match(new RegExp(REVIEW_REFERENCE_SOURCE, 'gi')) ?? [];
    return references.some(reference => {
      const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\w/.-])${escaped}(?=$|[^\\w/.:\\d-])`).test(normalizedTask);
    });
  });
}
