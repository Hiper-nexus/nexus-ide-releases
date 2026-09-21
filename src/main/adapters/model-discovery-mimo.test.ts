import { expect, it } from 'vitest';
import { parseMimoModelsOutput, MODEL_DISCOVERY_INVENTORY } from './model-discovery';
it('reads annotated MiMo model rows without treating metadata or other providers as Xiaomi models', () => {
  expect(parseMimoModelsOutput('xiaomi/mimo-v2.6-flash — window 1M, compacts at 900K\nmetadata\nopenai/gpt-test\nxiaomi/mimo-v2.6-pro\n')).toEqual(['xiaomi/mimo-v2.6-flash','xiaomi/mimo-v2.6-pro']);
  expect(MODEL_DISCOVERY_INVENTORY['mimo-code']).toEqual({ kind:'cli', command:'mimo --pure models xiaomi' });
});
