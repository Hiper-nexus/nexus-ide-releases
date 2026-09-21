import { expect, it } from 'vitest';
import { MIMO_CLI_MODELS, MIMO_CODE_DEFAULT_MODEL, MIMO_CODE_MODEL_IDS } from './mimo-models';
it('keeps official API IDs separate from CLI provider namespaces without invented evaluation scores', () => {
  expect(MIMO_CODE_DEFAULT_MODEL).toBe('xiaomi/mimo-v2.6-flash');
  expect(MIMO_CODE_MODEL_IDS).toHaveLength(3);
  expect(MIMO_CLI_MODELS['mimo-v2.6-pro'].cost).toEqual({ input:0.435, output:0.87, cache_read:0.0036 });
  expect(JSON.stringify(MIMO_CLI_MODELS)).not.toContain('quality');
});
