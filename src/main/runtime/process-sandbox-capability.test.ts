import { describe, expect, it } from 'vitest';
import { processSandboxRuntimeAvailable } from './process-sandbox-capability';

describe('processSandboxRuntimeAvailable', () => {
  it('returns a boolean without throwing', () => {
    expect(typeof processSandboxRuntimeAvailable()).toBe('boolean');
  });

  it.runIf(process.platform === 'darwin')('is true on darwin with Seatbelt', () => {
    expect(processSandboxRuntimeAvailable()).toBe(true);
  });
});
