import { describe, expect, it } from 'vitest';
import { redactVisibleSecrets } from './vision-ipc';

describe('Cloudflare token redaction', () => {
  it('hides standalone user and account tokens while preserving ordinary text', () => {
    expect(redactVisibleSecrets('cfut-synthetic_cloudflare_token_1234567890')).toBe('[REDACTED]');
    expect(redactVisibleSecrets('cfat-synthetic_cloudflare_token_1234567890')).toBe('[REDACTED]');
    expect(redactVisibleSecrets('Clef está disponível. cfut-curto')).toBe('Clef está disponível. cfut-curto');
  });
});
