import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isJarvisPoweredOff,
  powerOffJarvisInput,
  reactivateJarvisInput,
  registerJarvisPowerControl,
} from './jarvis-power-authority';

describe('Jarvis power authority', () => {
  beforeEach(() => {
    registerJarvisPowerControl(null);
    reactivateJarvisInput();
  });

  afterEach(() => {
    registerJarvisPowerControl(null);
    reactivateJarvisInput();
  });

  it('fails closed before stopping input and remains idempotently off', () => {
    const stopInput = vi.fn(() => {
      expect(isJarvisPoweredOff()).toBe(true);
    });
    registerJarvisPowerControl({ stopInput });

    powerOffJarvisInput();
    powerOffJarvisInput();

    expect(isJarvisPoweredOff()).toBe(true);
    expect(stopInput).toHaveBeenCalledTimes(2);
  });

  it('requires an explicit reactivation and stops a late controller registration', () => {
    powerOffJarvisInput();
    const stopInput = vi.fn();

    registerJarvisPowerControl({ stopInput });

    expect(stopInput).toHaveBeenCalledOnce();
    expect(reactivateJarvisInput()).toBe(true);
    expect(reactivateJarvisInput()).toBe(false);
    expect(isJarvisPoweredOff()).toBe(false);
  });
});
