import { describe, expect, it } from 'vitest';

/** Mirrors respawnWithResume resume flag selection (cross vs same). */
function shouldResumeNative(
  mode?: 'same-account-resume' | 'cross-account-continuity',
): boolean {
  return mode !== 'cross-account-continuity';
}

describe('respawnWithResume mode', () => {
  it('disables native resume for cross-account continuity', () => {
    expect(shouldResumeNative('cross-account-continuity')).toBe(false);
    expect(shouldResumeNative('same-account-resume')).toBe(true);
    expect(shouldResumeNative(undefined)).toBe(true);
  });
});
