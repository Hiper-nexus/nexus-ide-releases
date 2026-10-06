import { modelLineOf } from '../../shared/model-line';
import type { MissionReviewVerdict } from './mission-review-verdict-ledger';

export type RoutingPurpose = 'general' | 'writer' | 'reviewer' | 'finding-fix';
const WRITE_ACTION = /\b(?:implement(?:ar|e|ing)?|build|add|adicion(?:ar|e)|criar|crie|corrig(?:ir|e|a)|corrij[ae]|fix|refactor|refator(?:ar|e)|atualiz(?:ar|e)|update|modific(?:ar|ue)|change|write|escrev(?:er|a))\b/i;
const WRITE_LEADING = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)?(?:(?:por favor|please|quero que|preciso que|faça|faca)\\s+)?${WRITE_ACTION.source}`, 'i');
const READ_ONLY = /\bread[ -]only\b|\bsomente leitura\b|\bdo not (?:write|change|modify)\b|\bn[aã]o (?:altere|modifique|escreva)\b/i;
const FIX_ACTION = /\b(?:corrig(?:ir|e|a)|corrij[ae]|fix|repair|resolv(?:er|a|e))\b/i;
const FINDING_REFERENCE = /\b(?:achados?|findings?)\b|\bF-\d+\b|[\w.-]+\/[\w./-]+\.[a-z]+(?::\d+)?/i;

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
  const normalizedTask = task.replaceAll('\\', '/');
  return verdict.findings.some(finding => {
    const references = finding.replaceAll('\\', '/').match(/\bF-\d+\b|[\w.-]+\/[\w./-]+\.[a-z]+(?::\d+)?/g) ?? [];
    return references.some(reference => {
      const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\w/.-])${escaped}(?=$|[^\\w/.:\\d-])`).test(normalizedTask);
    });
  });
}
