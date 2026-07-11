import { describe, expect, it } from 'vitest';
import { shouldCreateWindowOnActivate } from './app-lifecycle';

describe('macOS activate lifecycle', () => {
  it('creates a window only while the app runtime is live', () => {
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: false,
        isShutdownComplete: false,
        windowCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: true,
        isShutdownComplete: false,
        windowCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: false,
        isShutdownComplete: true,
        windowCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: false,
        isShutdownComplete: false,
        windowCount: 1,
      }),
    ).toBe(false);
  });
});
