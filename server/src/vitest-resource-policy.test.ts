import { describe, expect, it } from 'vitest';

import config from '../vitest.config';

describe('server Vitest resource policy', () => {
  it('bounds PGlite concurrency and gives setup a finite CI deadline', () => {
    expect(config.test).toMatchObject({
      environment: 'node',
      hookTimeout: 15_000,
      maxWorkers: 2,
      testTimeout: 15_000,
    });
  });
});
