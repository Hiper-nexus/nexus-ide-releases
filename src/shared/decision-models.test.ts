import { describe, expect, it } from 'vitest';
import { orchSettingsSchema } from './settings-types';

describe('decision model configuration', () => {
  it('preserves native Jev behavior when loading old settings', () => {
    expect(orchSettingsSchema.parse({}).decisionModels).toEqual({
      mode: 'jev', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false,
    });
  });

  it('persists an explicit automatic selection without activating image egress', () => {
    const result = orchSettingsSchema.parse({ decisionModels: {
      mode: 'auto', cloudflareAccountId: '0123456789abcdef0123456789abcdef',
    } });
    expect(result.decisionModels).toMatchObject({ mode: 'auto', visionEnabled: false });
  });

  it.each([
    { mode: 'unknown' }, { clefModel: 'other/model' },
    { cloudflareAccountId: '../../another-account' }, { cloudflareAccountId: 'not-an-account' },
    { visionEnabled: 'true' },
  ])('rejects invalid provider configuration %j', decisionModels => {
    expect(orchSettingsSchema.safeParse({ decisionModels }).success).toBe(false);
  });
});
