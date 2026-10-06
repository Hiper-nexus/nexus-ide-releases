import { expect, it } from 'vitest';
import { isAstraModel, isFindingCorrectionTask, matchesReviewedFinding, routingPurpose } from './routing-cost-policy';
import type { MissionReviewVerdict } from './mission-review-verdict-ledger';
const verdict: MissionReviewVerdict = {
  verdictId: 'v1', missionId: 'm1', headSha: 'a'.repeat(40), treeDirty: false,
  verdict: 'reject', frontier: true, reviewerAdapter: 'claude', reviewerModel: 'claude-opus-5-5',
  findings: ['F-949 src/main/orch/tool-util.ts:653 precisa repetir o Enter'], summary: 'rejeitado', createdAt: 1,
};
it('a correction candidate requires a fix action and a finding reference, not ordinary file implementation', () => {
  expect(isFindingCorrectionTask('Corrija F-949')).toBe(true);
  expect(isFindingCorrectionTask('Implemente uma feature em src/ui/view.ts')).toBe(false);
  expect(isFindingCorrectionTask('Revise somente leitura src/ui/view.ts')).toBe(false);
});
it('finding identity is exact, including path and line, rather than a substring or a caller assertion', () => {
  expect(matchesReviewedFinding('Corrija F-949', verdict, 'm1', verdict.headSha)).toBe(true);
  expect(matchesReviewedFinding('Corrija F-9490', verdict, 'm1', verdict.headSha)).toBe(false);
  expect(matchesReviewedFinding('Corrija src/main/orch/tool-util.ts:653', verdict, 'm1', verdict.headSha)).toBe(true);
  expect(matchesReviewedFinding('Corrija src/main/orch/tool-util.ts:6530', verdict, 'm1', verdict.headSha)).toBe(false);
  expect(matchesReviewedFinding('Corrija F-949', verdict, 'other', verdict.headSha)).toBe(false);
});
it('a read-only code review remains judgment even when it describes implementing or fixing code', () => {
  expect(routingPurpose('Revise somente leitura a implementação; não altere código', true)).toBe('reviewer');
  expect(routingPurpose('Corrija F-949', false, false)).toBe('writer');
  expect(routingPurpose('Corrija F-949', false, true)).toBe('finding-fix');
});
it('reviewing a fix is reviewer work, while implementing a review gate is writer work', () => {
  expect(routingPurpose('Review the fix for memory leaks and approve or reject', true)).toBe('reviewer');
  expect(routingPurpose('Implemente o gate de code review da branch', true)).toBe('writer');
});
it('Astra exclusions follow newer versions in the same model line', () => {
  expect(isAstraModel('codex', 'gpt-6.2-astra-preview')).toBe(true);
  expect(isAstraModel('codex', 'gpt-6.2-sol')).toBe(false);
});
