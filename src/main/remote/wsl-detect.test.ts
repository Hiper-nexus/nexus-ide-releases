import { describe, expect, it } from 'vitest';
import { detectWslFromEnv } from './wsl-detect';

describe('detectWslFromEnv', () => {
  it('detects WSL env markers', () => {
    expect(detectWslFromEnv({ WSL_DISTRO_NAME: 'Ubuntu' }).available).toBe(true);
    expect(detectWslFromEnv({}).available).toBe(false);
  });
});
