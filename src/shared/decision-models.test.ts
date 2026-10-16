import { describe, expect, it } from 'vitest';
import { decisionSettingsSchema, hasAudioRecipientConsent, hasVisionRecipientConsent, testDecisionModelRequestSchema, visionRecipientsForMode } from './decision-models';
import { orchSettingsSchema } from './settings-types';

describe('decision model configuration', () => {
  it('accepts the verified Jev preview without silently accepting invented model ids', () => {
    expect(decisionSettingsSchema.parse({ jevModel: 'jev-1.14.0' }).jevModel).toBe('jev-1.14.0');
    expect(decisionSettingsSchema.safeParse({ jevModel: 'jev-1.14.0-preview' }).success).toBe(false);
  });
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

  it('keeps image analysis in every mode and drops the consent only when it is turned off', () => {
    const account = '0123456789abcdef0123456789abcdef';
    for (const mode of ['auto', 'clef', 'jev', 'luna', 'together'] as const) {
      expect(orchSettingsSchema.parse({ decisionModels: { mode, cloudflareAccountId: account, visionEnabled: true } }).decisionModels.visionEnabled).toBe(true);
    }
    const off = orchSettingsSchema.parse({ decisionModels: { mode: 'auto', cloudflareAccountId: account, visionEnabled: false,
      visionConsent: { version: 1, recipients: ['clef', 'luna'] } } });
    expect(off.decisionModels.visionConsent).toEqual({ version: 1, recipients: [] });
    // Turning it back on never resurrects the old consent: it is not stored anywhere.
    expect(hasVisionRecipientConsent({ ...off.decisionModels, visionEnabled: true }, 'clef')).toBe(false);
  });

  it('requires explicit recipient-specific consent, also in Somente Jev', () => {
    const old = decisionSettingsSchema.parse({ mode: 'auto', visionEnabled: true });
    expect(hasVisionRecipientConsent(old, 'clef')).toBe(true);
    expect(hasVisionRecipientConsent(old, 'luna')).toBe(false);
    const saved = decisionSettingsSchema.parse({ ...old, visionConsent: { version: 1, recipients: ['luna'] } });
    expect(hasVisionRecipientConsent(saved, 'luna')).toBe(true);
    expect(hasVisionRecipientConsent(saved, 'clef')).toBe(false);
    const jev = decisionSettingsSchema.parse({ ...saved, mode: 'jev' });
    expect(hasVisionRecipientConsent(jev, 'luna')).toBe(true);
    expect(hasVisionRecipientConsent(jev, 'clef')).toBe(false);
    expect(hasVisionRecipientConsent(decisionSettingsSchema.parse({ mode: 'jev', visionEnabled: true }), 'clef')).toBe(true);
    const disabled = decisionSettingsSchema.parse({ ...saved, visionEnabled: false });
    expect(hasVisionRecipientConsent({ ...disabled, visionEnabled: true }, 'luna')).toBe(false);
  });

  it('offers Somente Jev the same image recipients as Automatic', () => {
    expect(visionRecipientsForMode('jev')).toEqual(['clef', 'luna']);
    expect(visionRecipientsForMode('auto')).toEqual(['clef', 'luna']);
    expect(visionRecipientsForMode('clef')).toEqual(['clef']);
    expect(visionRecipientsForMode('luna')).toEqual(['luna']);
  });

  it('accepts clef-omni as a variant while keeping existing values and the default unchanged', () => {
    expect(decisionSettingsSchema.parse({}).clefModel).toBe('clef');
    for (const clefModel of ['clef', 'clef-flash', 'clef-omni'] as const) {
      expect(decisionSettingsSchema.parse({ mode: 'clef', clefModel }).clefModel).toBe(clefModel);
    }
    expect(testDecisionModelRequestSchema.parse({ model: 'clef-omni' })).toEqual({ model: 'clef-omni' });
    expect(testDecisionModelRequestSchema.safeParse({ model: 'clef-omni-2' }).success).toBe(false);
  });

  it('keeps audio off by default and separate from the image consent', () => {
    const omni = decisionSettingsSchema.parse({ mode: 'clef', clefModel: 'clef-omni', visionEnabled: true });
    expect(omni).not.toHaveProperty('audioConsent');
    expect(hasVisionRecipientConsent(omni, 'clef')).toBe(true);
    expect(hasAudioRecipientConsent(omni, 'clef')).toBe(false);
    const granted = decisionSettingsSchema.parse({ ...omni, audioConsent: { version: 1, recipients: ['clef'] } });
    expect(hasAudioRecipientConsent(granted, 'clef')).toBe(true);
    expect(hasAudioRecipientConsent({ ...granted, visionEnabled: false }, 'clef')).toBe(true);
  });

  it.each([
    ['Somente Jev', { mode: 'jev' }], ['Somente Luna', { mode: 'luna' }], ['Clef sem omni', { clefModel: 'clef' }], ['Flash', { clefModel: 'clef-flash' }],
  ] as const)('drops the audio consent when the route can no longer hear it (%s)', (_label, change) => {
    const granted = { mode: 'clef', clefModel: 'clef-omni', audioConsent: { version: 1, recipients: ['clef'] } };
    const parsed = decisionSettingsSchema.parse({ ...granted, ...change });
    expect(parsed.audioConsent).toEqual({ version: 1, recipients: [] });
    // Voltar ao Clef-omni não ressuscita a autorização antiga.
    expect(hasAudioRecipientConsent(decisionSettingsSchema.parse({ ...parsed, mode: 'clef', clefModel: 'clef-omni' }), 'clef')).toBe(false);
  });

  it.each([
    { audioConsent: { version: 2, recipients: ['clef'] } },
    { audioConsent: { version: 1, recipients: ['luna'] } },
    { audioConsent: { version: 1, recipients: ['clef'], endpoint: 'https://other-host' } },
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
