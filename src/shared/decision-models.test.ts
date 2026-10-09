import { describe, expect, it } from 'vitest';
import { decisionSettingsSchema, hasVisionRecipientConsent } from './decision-models';
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

  it('drops the image-egress consent as soon as the mode can no longer send images', () => {
    const account = '0123456789abcdef0123456789abcdef';
    for (const mode of ['auto', 'clef'] as const) {
      expect(orchSettingsSchema.parse({ decisionModels: { mode, cloudflareAccountId: account, visionEnabled: true } }).decisionModels.visionEnabled).toBe(true);
    }
    const jev = orchSettingsSchema.parse({ decisionModels: { mode: 'jev', cloudflareAccountId: account, visionEnabled: true } });
    expect(jev.decisionModels.visionEnabled).toBe(false);
    // Coming back to automatic never resurrects the old consent: it is not stored anywhere.
    expect(orchSettingsSchema.parse({ decisionModels: { ...jev.decisionModels, mode: 'auto' } }).decisionModels.visionEnabled).toBe(false);
    expect(orchSettingsSchema.parse({ decisionModels: { mode: 'luna', visionEnabled: true } }).decisionModels.visionEnabled).toBe(true);
    expect(orchSettingsSchema.parse({ decisionModels: { mode: 'together', visionEnabled: true } }).decisionModels.visionEnabled).toBe(true);
  });

  it('requires explicit recipient-specific consent and clears it when Jev is selected', () => {
    const old = decisionSettingsSchema.parse({ mode: 'auto', visionEnabled: true });
    expect(hasVisionRecipientConsent(old, 'clef')).toBe(true);
    expect(hasVisionRecipientConsent(old, 'luna')).toBe(false);
    const saved = decisionSettingsSchema.parse({ ...old, visionConsent: { version: 1, recipients: ['luna'] } });
    expect(hasVisionRecipientConsent(saved, 'luna')).toBe(true);
    expect(hasVisionRecipientConsent(saved, 'clef')).toBe(false);
    const optedOut = decisionSettingsSchema.parse({ ...saved, mode: 'jev' });
    expect(hasVisionRecipientConsent({ ...optedOut, mode: 'auto', visionEnabled: true }, 'luna')).toBe(false);
    const disabled = decisionSettingsSchema.parse({ ...saved, visionEnabled: false });
    expect(hasVisionRecipientConsent({ ...disabled, visionEnabled: true }, 'luna')).toBe(false);
  });

  it.each([
    { visionConsent: { version: 2, recipients: ['luna'] } },
    { visionConsent: { version: 1, recipients: ['other-host'] } },
    { visionConsent: { version: 1, recipients: ['luna'], redirect: 'https://other-host' } },
    { mode: 'unknown' }, { clefModel: 'other/model' },
    { cloudflareAccountId: '../../another-account' }, { cloudflareAccountId: 'not-an-account' },
    { visionEnabled: 'true' },
  ])('rejects invalid provider configuration %j', decisionModels => {
    expect(orchSettingsSchema.safeParse({ decisionModels }).success).toBe(false);
  });
});
