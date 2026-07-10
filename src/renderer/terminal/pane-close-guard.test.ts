import { describe, expect, it } from 'vitest';
import { paneCloseNeedsConfirmation } from './pane-close-guard';

describe('paneCloseNeedsConfirmation', () => {
  it('protects busy and spawning terminal processes', () => {
    expect(paneCloseNeedsConfirmation('cli-agent', 'busy')).toBe(true);
    expect(paneCloseNeedsConfirmation('cli-agent', 'spawning')).toBe(true);
    expect(paneCloseNeedsConfirmation('shell', 'busy')).toBe(true);
  });

  it('allows completed, sleeping, idle and browser panes to close directly', () => {
    expect(paneCloseNeedsConfirmation('cli-agent', 'idle')).toBe(false);
    expect(paneCloseNeedsConfirmation('cli-agent', 'exited')).toBe(false);
    expect(paneCloseNeedsConfirmation('shell', 'hibernated')).toBe(false);
    expect(paneCloseNeedsConfirmation('browser', 'busy')).toBe(false);
  });
});
