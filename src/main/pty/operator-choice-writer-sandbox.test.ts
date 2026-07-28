import { describe, expect, it } from 'vitest';
import { isOperatorChoiceWorkspaceWrite } from './operator-choice-writer-sandbox';

describe('isOperatorChoiceWorkspaceWrite', () => {
  it('opens only under operator-choice for non-Codex writers', () => {
    expect(
      isOperatorChoiceWorkspaceWrite({
        squadCliPolicy: 'operator-choice',
        adapterId: 'kimi',
        writableWorkerIntent: true,
        hasCodexNativeWriteAuthority: false,
      }),
    ).toBe(true);
    expect(
      isOperatorChoiceWorkspaceWrite({
        squadCliPolicy: 'governed',
        adapterId: 'kimi',
        writableWorkerIntent: true,
        hasCodexNativeWriteAuthority: false,
      }),
    ).toBe(false);
    expect(
      isOperatorChoiceWorkspaceWrite({
        squadCliPolicy: 'operator-choice',
        adapterId: 'codex',
        writableWorkerIntent: true,
        hasCodexNativeWriteAuthority: true,
      }),
    ).toBe(false);
  });
});
