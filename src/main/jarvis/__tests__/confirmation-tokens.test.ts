import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConfirmationTokensForTests,
  consumeConfirmationToken,
  createConfirmationToken,
} from '../confirmation-tokens';
import type { PermissionScope } from '../permissions';

const SCOPE: PermissionScope = {
  sessionId: 'jarvis-renderer',
  workspaceId: '/tmp/nexus',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  toolName: 'nexus_terminal_run',
  args: { command: 'npm test' },
};

describe('confirmation tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));
    clearConfirmationTokensForTests();
  });

  afterEach(() => {
    clearConfirmationTokensForTests();
    vi.useRealTimers();
  });

  it('can be consumed only once for the exact permission scope', () => {
    const token = createConfirmationToken(SCOPE);

    expect(consumeConfirmationToken(token, SCOPE)).toBe(true);
    expect(consumeConfirmationToken(token, SCOPE)).toBe(false);
  });

  it('rejects the same token for different args', () => {
    const token = createConfirmationToken(SCOPE);

    expect(
      consumeConfirmationToken(token, {
        ...SCOPE,
        args: { command: 'npm run typecheck' },
      }),
    ).toBe(false);
  });

  it('rejects the same token in another checkout of the same project', () => {
    const token = createConfirmationToken(SCOPE);

    expect(
      consumeConfirmationToken(token, { ...SCOPE, checkoutId: 'checkout-b' }),
    ).toBe(false);
  });

  it('expires tokens after the native confirmation window', () => {
    const token = createConfirmationToken(SCOPE);

    vi.advanceTimersByTime(30_001);

    expect(consumeConfirmationToken(token, SCOPE)).toBe(false);
  });
});
