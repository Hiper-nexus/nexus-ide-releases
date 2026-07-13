import { describe, expect, it, vi } from 'vitest';
import { LiveContextSynchronizer } from './live-context-sync';

describe('LiveContextSynchronizer', () => {
  it('publishes the current screen immediately and only when it changes', () => {
    let context = 'Current Nexus screen: home; squads: Code Review.';
    const publish = vi.fn();
    const sync = new LiveContextSynchronizer({
      isEnabled: () => true,
      read: () => context,
      publish,
    });

    expect(sync.tick()).toBe(true);
    expect(sync.tick()).toBe(false);
    context = 'Current Nexus screen: squad wizard open.';
    expect(sync.tick()).toBe(true);
    expect(publish).toHaveBeenNthCalledWith(1, 'Current Nexus screen: home; squads: Code Review.');
    expect(publish).toHaveBeenNthCalledWith(2, 'Current Nexus screen: squad wizard open.');
  });

  it('resets its baseline while Live is disabled', () => {
    let enabled = true;
    const publish = vi.fn();
    const sync = new LiveContextSynchronizer({
      isEnabled: () => enabled,
      read: () => 'Current Nexus screen: home.',
      publish,
    });

    expect(sync.tick()).toBe(true);
    enabled = false;
    expect(sync.tick()).toBe(false);
    enabled = true;
    expect(sync.tick()).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
