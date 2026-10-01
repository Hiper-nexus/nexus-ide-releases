import { describe, expect, it } from 'vitest';
import { resolveDecisionRoute } from './decision-routing';
import type { DecisionSettings } from '../../shared/decision-models';

const settings: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false };
const both = { jev: true, clef: true };

describe('complementary decision routing', () => {
  it('uses Clef for tool selection and Jev for tasks without a local promotion', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, both)).toMatchObject({ provider: 'clef', model: 'clef', evidence: 'public-benchmark' });
    for (const surface of ['intake', 'taskRouting', 'delegation', 'paneState', 'terminalTriage', 'rank', 'dispatchGuard', 'handoffReview', 'researchTriage', 'memoryDistill', 'helperReuse', 'businessModel', 'browserTool'] as const) {
      expect(resolveDecisionRoute({ surface }, settings, both)?.provider).toBe('jev');
    }
  });

  it('never silently switches a fixed provider when its credentials are missing', () => {
    expect(resolveDecisionRoute({}, { ...settings, mode: 'jev' }, { jev: false, clef: true })).toBeNull();
    expect(resolveDecisionRoute({}, { ...settings, mode: 'clef' }, { jev: true, clef: false })).toBeNull();
  });

  it('uses an available text provider in automatic mode and identifies the fallback', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, { jev: true, clef: false })).toMatchObject({ provider: 'jev', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'researchTriage' }, settings, { jev: false, clef: true })).toMatchObject({ provider: 'clef', reason: 'credential-fallback' });
  });

  it('keeps image requests on Clef and requires explicit visual egress', () => {
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(resolveDecisionRoute({ images }, settings, both)).toBeNull();
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true }, both)).toMatchObject({ provider: 'clef', evidence: 'capability' });
    expect(resolveDecisionRoute({ images }, { ...settings, mode: 'jev', visionEnabled: true }, both)).toBeNull();
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true }, { jev: true, clef: false })).toBeNull();
  });

  it('honors a configured Flash variant in Clef-only mode', () => {
    expect(resolveDecisionRoute({}, { ...settings, mode: 'clef', clefModel: 'clef-flash' }, both)).toMatchObject({ provider: 'clef', model: 'clef-flash', evidence: 'manual' });
  });

  it('does not allow a model argument to override a fixed provider or variant', () => {
    expect(resolveDecisionRoute({ model: 'clef' }, { ...settings, mode: 'jev' }, both)).toBeNull();
    expect(resolveDecisionRoute({ model: 'jev-latest' }, { ...settings, mode: 'clef' }, both)).toBeNull();
    expect(resolveDecisionRoute({ model: 'clef-flash' }, { ...settings, mode: 'clef', clefModel: 'clef' }, both)).toBeNull();
  });

  it('allows an explicit model within automatic mode without changing settings', () => {
    expect(resolveDecisionRoute({ model: 'clef-flash' }, settings, both)).toMatchObject({ provider: 'clef', model: 'clef-flash', reason: 'explicit-model' });
    expect(settings.mode).toBe('auto');
  });
});
