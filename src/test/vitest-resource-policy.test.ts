import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

describe('root Vitest resource policy', () => {
  it('bounds mixed Electron, OCR and PGlite concurrency', () => {
    expect(config.test).toMatchObject({
      hookTimeout: 15_000,
      maxWorkers: 4,
      testTimeout: 15_000,
    });
  });

  it('never discovers copied suites inside Nexus runtime worktrees', () => {
    expect(config.test?.exclude).toContain('.dev-user-data/**');
  });
});
