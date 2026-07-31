import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearWizardPlanReviewGrantsForTests,
  consumeWizardPlanReviewGrant,
  recordWizardPlanReviewGrant,
} from './mission-wizard-plan-review-grant';

function owner(id: number): WebContents {
  return { id } as WebContents;
}

beforeEach(() => {
  clearWizardPlanReviewGrantsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  clearWizardPlanReviewGrantsForTests();
});

describe('wizard plan review grant', () => {
  it('consome uma vez o grant ligado a sender+missão+intentVersion', () => {
    const sender = owner(1);
    recordWizardPlanReviewGrant(sender, 'mission-1', 3);

    expect(consumeWizardPlanReviewGrant(sender, 'mission-1', 3)).toBe(true);
    // Single-use: o segundo approve da mesma submissão cai no modal nativo.
    expect(consumeWizardPlanReviewGrant(sender, 'mission-1', 3)).toBe(false);
  });

  it('recusa e invalida quando o intentVersion revisado mudou', () => {
    const sender = owner(1);
    recordWizardPlanReviewGrant(sender, 'mission-1', 3);

    expect(consumeWizardPlanReviewGrant(sender, 'mission-1', 4)).toBe(false);
    // Grant divergente é descartado — não fica à espreita para um approve futuro.
    expect(consumeWizardPlanReviewGrant(sender, 'mission-1', 3)).toBe(false);
  });

  it('isola grants por sender e por missão', () => {
    recordWizardPlanReviewGrant(owner(1), 'mission-1', 3);

    expect(consumeWizardPlanReviewGrant(owner(2), 'mission-1', 3)).toBe(false);
    expect(consumeWizardPlanReviewGrant(owner(1), 'mission-2', 3)).toBe(false);
    expect(consumeWizardPlanReviewGrant(owner(1), 'mission-1', 3)).toBe(true);
  });

  it('re-submissão sobrescreve: só o intentVersion mais novo é válido', () => {
    const sender = owner(1);
    recordWizardPlanReviewGrant(sender, 'mission-1', 3);
    recordWizardPlanReviewGrant(sender, 'mission-1', 4);

    expect(consumeWizardPlanReviewGrant(sender, 'mission-1', 4)).toBe(true);

    recordWizardPlanReviewGrant(sender, 'mission-2', 3);
    recordWizardPlanReviewGrant(sender, 'mission-2', 4);
    expect(consumeWizardPlanReviewGrant(sender, 'mission-2', 3)).toBe(false);
  });

  it('expira após o TTL da revisão humana', () => {
    vi.useFakeTimers();
    const sender = owner(1);
    recordWizardPlanReviewGrant(sender, 'mission-1', 3);

    vi.advanceTimersByTime(30 * 60 * 1_000 + 1);
    expect(consumeWizardPlanReviewGrant(sender, 'mission-1', 3)).toBe(false);
  });
});
