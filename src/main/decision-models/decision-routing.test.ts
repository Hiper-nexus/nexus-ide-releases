import { describe, expect, it } from 'vitest';
import { resolveDecisionRoute } from './decision-routing';
import type { DecisionSettings } from '../../shared/decision-models';

const settings: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false };
const both = { jev: true, clef: true };

describe('complementary decision routing', () => {
  it('uses Clef for tool selection and Jev for tasks without a local promotion', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, both)).toMatchObject({ provider: 'clef', model: 'clef', evidence: 'public-benchmark' });
    for (const surface of ['intake', 'taskRouting', 'delegation', 'paneState', 'terminalTriage', 'rank', 'rankTool', 'judgeTool', 'researchTriage', 'helperReuse', 'businessModel'] as const) {
      expect(resolveDecisionRoute({ surface }, settings, both)?.provider).toBe('jev');
    }
  });

  describe('effect-bearing surfaces stay on Jev (no Clef evaluation exists for their thresholds)', () => {
    const pinned = ['dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool', 'browserTool'] as const;
    it('routes them to Jev in automatic and Jev-only modes', () => {
      for (const surface of pinned) {
        expect(resolveDecisionRoute({ surface }, settings, both)).toMatchObject({ provider: 'jev' });
        expect(resolveDecisionRoute({ surface }, { ...settings, mode: 'jev' }, both)).toMatchObject({ provider: 'jev' });
      }
    });
    it('never sends them to Clef: Clef-only mode and a missing Jev key yield no route', () => {
      for (const surface of pinned) {
        expect(resolveDecisionRoute({ surface }, { ...settings, mode: 'clef' }, both)).toBeNull();
        expect(resolveDecisionRoute({ surface }, { ...settings, mode: 'clef' }, { jev: false, clef: true })).toBeNull();
        expect(resolveDecisionRoute({ surface }, settings, { jev: false, clef: true })).toBeNull();
        expect(resolveDecisionRoute({ surface, model: 'clef' }, settings, both)).toBeNull();
        expect(resolveDecisionRoute({ surface, model: 'clef-flash' }, settings, both)).toBeNull();
      }
    });
    it('still lets the explicit visual capability use Clef for an image on the browser surface', () => {
      const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
      expect(resolveDecisionRoute({ surface: 'browserTool', images }, { ...settings, visionEnabled: true }, both)).toMatchObject({ provider: 'clef', evidence: 'capability' });
    });
  });

  it('never silently switches a fixed provider when its credentials are missing', () => {
    expect(resolveDecisionRoute({}, { ...settings, mode: 'jev' }, { jev: false, clef: true })).toBeNull();
    expect(resolveDecisionRoute({}, { ...settings, mode: 'clef' }, { jev: true, clef: false })).toBeNull();
  });

  it('uses an available text provider in automatic mode and identifies the fallback', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, { jev: true, clef: false })).toMatchObject({ provider: 'jev', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'researchTriage' }, settings, { jev: false, clef: true })).toMatchObject({ provider: 'clef', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'judgeTool' }, settings, { jev: false, clef: true })).toMatchObject({ provider: 'clef', reason: 'credential-fallback' });
  });

  it('keeps image requests on Clef and requires explicit visual egress', () => {
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(resolveDecisionRoute({ images }, settings, both)).toBeNull();
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true }, both)).toMatchObject({ provider: 'clef', evidence: 'capability' });
    expect(resolveDecisionRoute({ images }, { ...settings, mode: 'jev', visionEnabled: true }, both)).toBeNull();
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true }, { jev: true, clef: false })).toBeNull();
    // Imagem não contorna a fixação: só o julgamento visual do navegador pode levar imagem ao Clef.
    for (const surface of ['dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool'] as const) {
      expect(resolveDecisionRoute({ surface, images }, { ...settings, visionEnabled: true }, both)).toBeNull();
    }
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
