import { describe, expect, it } from 'vitest';
import { UI_COMPOSITION_POLICY, withUiCompositionPolicy } from './ui-composition-policy';
import { withoutMountedPromptContextBlocks } from './prompt-context-blocks';
import { charterTierForWorker } from './worker-handoff-contract';
import { visualTaskRequirement } from './visual-handoff-gate';

describe('mandatory UI baseline in task context', () => {
  it('survives repeated assembly without duplicating the baseline or losing the task', () => {
    const task = 'Review the task card'; // deliberately outside the UI vocabulary
    const once = withUiCompositionPolicy(task);
    expect(once).toContain(UI_COMPOSITION_POLICY);
    expect(withUiCompositionPolicy(once)).toBe(once);
    expect(withoutMountedPromptContextBlocks(once)).toBe(task);
  });

  it('does not grant a backend task design coaching or a screenshot requirement', () => {
    const prompt = withUiCompositionPolicy('Corrija a paginação SQL do backend');
    expect(charterTierForWorker({ prompt }).design).toBe(false);
    expect(visualTaskRequirement(prompt)).toBeUndefined();
  });

  it('does not hide a real UI task from the existing capture gate', () => {
    const prompt = withUiCompositionPolicy('Crie a tela de login com layout responsivo');
    expect(charterTierForWorker({ prompt }).design).toBe(true);
    expect(visualTaskRequirement(prompt)).toBeDefined();
  });
});
