import { describe, expect, it } from 'vitest';
import {
  KIMI_TRANSIENT_MODEL_ENV_KEYS,
  buildKimiApiKeyRuntimeEnv,
} from './kimi-runtime-env';

describe('buildKimiApiKeyRuntimeEnv', () => {
  it('uses Kimi Code official transient-model env without persisting the key', () => {
    expect(
      buildKimiApiKeyRuntimeEnv('sk-kimi', 'kimi-code/kimi-for-coding'),
    ).toEqual({
      KIMI_MODEL_API_KEY: 'sk-kimi',
      KIMI_MODEL_NAME: 'kimi-for-coding',
    });
  });

  it('preserves ordinary model ids and lists every env suppressed for OAuth', () => {
    expect(buildKimiApiKeyRuntimeEnv('sk-kimi', 'kimi-k2.7')).toEqual({
      KIMI_MODEL_API_KEY: 'sk-kimi',
      KIMI_MODEL_NAME: 'kimi-k2.7',
    });
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_API_KEY');
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_NAME');
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_BASE_URL');
    expect(KIMI_TRANSIENT_MODEL_ENV_KEYS).toContain('KIMI_MODEL_THINKING_KEEP');
  });

  it('rejects incomplete transient credentials before spawning Kimi', () => {
    expect(() => buildKimiApiKeyRuntimeEnv('', 'kimi-for-coding')).toThrow(
      'non-empty key',
    );
    expect(() => buildKimiApiKeyRuntimeEnv('sk-kimi', ' ')).toThrow(
      'model name',
    );
  });
});
