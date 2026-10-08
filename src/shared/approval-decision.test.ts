import { describe, expect, it } from 'vitest';
import {
  encodeApprovalPrompt,
  isApprovalDecision,
  parseApprovalPrompt,
  type PendingApprovalEnvelope,
} from './approval-decision';

const envelope: PendingApprovalEnvelope = {
  requestId: 'req-1',
  revision: 1,
  tool: 'Bash',
  summary: 'touch probe.txt',
  options: [{ optionId: 'accept' }, { optionId: 'acceptForSession', degradesTo: 'accept' }, { optionId: 'decline' }],
  responseCapability: 'live',
};

describe('approval-decision', () => {
  it('knows the T3 decisions and nothing else', () => {
    expect(isApprovalDecision('acceptForSession')).toBe(true);
    expect(isApprovalDecision('acceptAlways')).toBe(false);
    expect(isApprovalDecision(1)).toBe(false);
  });

  it('round-trips the structured envelope through the interactivePrompt JSON', () => {
    expect(parseApprovalPrompt(encodeApprovalPrompt(envelope))).toEqual({
      tool: 'Bash',
      summary: 'touch probe.txt',
      structured: envelope,
    });
  });

  it('reads the old `{ tool, summary }` envelope as a host without broker', () => {
    expect(parseApprovalPrompt(JSON.stringify({ approval: { tool: 'Edit', summary: 'a.ts' } }))).toEqual({
      tool: 'Edit',
      summary: 'a.ts',
      structured: null,
    });
  });

  it('drops a broken structured envelope instead of degrading it to a keystroke card', () => {
    for (const broken of [
      { ...envelope, revision: 0 },
      { ...envelope, requestId: ' padded ' },
      { ...envelope, options: [{ optionId: 'acceptAlways' }] },
      { ...envelope, options: [] },
      { ...envelope, responseCapability: 'maybe' },
    ]) {
      expect(parseApprovalPrompt(JSON.stringify({ approval: broken }))).toBeNull();
    }
    expect(parseApprovalPrompt('not json')).toBeNull();
    expect(parseApprovalPrompt(JSON.stringify({ questions: [] }))).toBeNull();
  });
});
