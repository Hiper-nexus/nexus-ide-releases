import { describe, expect, it } from 'vitest';
import { canRouteBrowserVisual, clefModel, ensembleMembers, resolveDecisionRoute } from './decision-routing';
import { decisionSettingsSchema, type DecisionSettings } from '../../shared/decision-models';

const settings: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false };
const visionConsent: NonNullable<DecisionSettings['visionConsent']> = { version: 1, recipients: ['clef', 'luna'] };
const both = { jev: true, clef: true };
describe('complementary decision routing', () => {
  it('uses Clef for tool selection, researchTriage, and rank in auto mode (F-783)', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, both)).toMatchObject({ provider: 'clef', model: 'clef', evidence: 'public-benchmark' });
    expect(resolveDecisionRoute({ surface: 'researchTriage' }, settings, both)).toMatchObject({
      provider: 'clef',
      model: 'clef',
      evidence: 'public-benchmark',
    });
    expect(resolveDecisionRoute({ surface: 'rank' }, settings, both)).toMatchObject({
      provider: 'clef',
      model: 'clef',
      evidence: 'public-benchmark',
    });
    expect(resolveDecisionRoute({ surface: 'rankTool' }, settings, both)).toMatchObject({
      provider: 'clef',
      model: 'clef',
      evidence: 'public-benchmark',
    });
    for (const surface of ['intake', 'taskRouting', 'delegation', 'paneState', 'terminalTriage', 'judgeTool', 'helperReuse', 'businessModel', 'missionPick', 'catalogPick'] as const) {
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

  describe('missionPick (voice mission tie-break) is a text surface that is NOT pinned to Jev', () => {
    // O que a escolha faz é abrir uma tela de missão — reversível e dita em voz alta —, e a
    // regra de aceitação (confiança ≥ 0,7 e margem ≥ 0,15) vale para qualquer provedor.
    // Sem decisão, o assistente pergunta; por isso nunca fica sem rota por falta de Jev.
    it('follows the generic text policy in every mode', () => {
      expect(resolveDecisionRoute({ surface: 'missionPick' }, settings, both)).toMatchObject({ provider: 'jev' });
      expect(resolveDecisionRoute({ surface: 'missionPick' }, settings, { jev: false, clef: true })).toMatchObject({ provider: 'clef', reason: 'credential-fallback' });
      expect(resolveDecisionRoute({ surface: 'missionPick' }, { ...settings, mode: 'jev' }, both)).toMatchObject({ provider: 'jev', evidence: 'manual' });
      expect(resolveDecisionRoute({ surface: 'missionPick' }, { ...settings, mode: 'clef' }, both)).toMatchObject({ provider: 'clef', evidence: 'manual' });
    });

    it('has no route (so no call and no decision) without any credential, or with the other provider fixed', () => {
      expect(resolveDecisionRoute({ surface: 'missionPick' }, settings, { jev: false, clef: false })).toBeNull();
      expect(resolveDecisionRoute({ surface: 'missionPick' }, { ...settings, mode: 'jev' }, { jev: false, clef: true })).toBeNull();
      expect(resolveDecisionRoute({ surface: 'missionPick' }, { ...settings, mode: 'clef' }, { jev: true, clef: false })).toBeNull();
    });
  });

  it('catalogPick (Marketplace recommendations, F-757) is a text surface the Clef can serve', () => {
    // Recomendar não instala nada: o operador confirma cada instalação nos
    // diálogos nativos, então não há motivo para fixar no Jev.
    expect(resolveDecisionRoute({ surface: 'catalogPick' }, settings, { jev: false, clef: true })).toMatchObject({
      provider: 'clef',
      reason: 'credential-fallback',
    });
    expect(resolveDecisionRoute({ surface: 'catalogPick' }, settings, { jev: false, clef: false })).toBeNull();
  });

  it('never silently switches a fixed provider when its credentials are missing', () => {
    expect(resolveDecisionRoute({}, { ...settings, mode: 'jev' }, { jev: false, clef: true })).toBeNull();
    expect(resolveDecisionRoute({}, { ...settings, mode: 'clef' }, { jev: true, clef: false })).toBeNull();
  });

  it('uses an available text provider in automatic mode and identifies the fallback', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, { jev: true, clef: false })).toMatchObject({ provider: 'jev', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'researchTriage' }, settings, { jev: true, clef: false })).toMatchObject({ provider: 'jev', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'judgeTool' }, settings, { jev: false, clef: true })).toMatchObject({ provider: 'clef', reason: 'credential-fallback' });
  });


  it('keeps image requests on Clef and requires explicit visual egress', () => {
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(resolveDecisionRoute({ images }, settings, both)).toBeNull();
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true }, both)).toMatchObject({ provider: 'clef', evidence: 'capability' });
    expect(resolveDecisionRoute({ images }, { ...settings, mode: 'jev', visionEnabled: true }, both)).toBeNull();
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true }, { jev: true, clef: false })).toBeNull();
    const lunaOnly = { jev: false, clef: false, luna: true };
    const vision = { ...settings, visionEnabled: true };
    expect(resolveDecisionRoute({ images, model: 'clef' }, vision, lunaOnly)).toBeNull();
    expect(resolveDecisionRoute({ images, model: 'clef-flash' }, vision, lunaOnly)).toBeNull();
    expect(resolveDecisionRoute({ surface: 'browserTool', images, model: 'clef' }, vision, lunaOnly)).toBeNull();
    expect(resolveDecisionRoute({ images, model: 'clef' }, vision, { jev: false, clef: true, luna: true })).toMatchObject({ provider: 'clef', model: 'clef' });
    // Imagem não contorna a fixação: só o julgamento visual do navegador pode levar imagem ao Clef.
    for (const surface of ['dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool'] as const) {
      expect(resolveDecisionRoute({ surface, images }, { ...settings, visionEnabled: true }, both)).toBeNull();
    }
  });

  it('honors a configured Flash variant in Clef-only mode', () => {
    expect(resolveDecisionRoute({}, { ...settings, mode: 'clef', clefModel: 'clef-flash' }, both)).toMatchObject({ provider: 'clef', model: 'clef-flash', evidence: 'manual' });
  });

  it('recognizes clef-omni as a Clef variant and routes every Clef-only surface to it', () => {
    expect(clefModel('clef-omni')).toBe('clef-omni');
    expect(clefModel('@cf/cloudflare/clef-omni')).toBe('clef-omni');
    expect(clefModel('clef-omni-preview')).toBeUndefined();
    const omni: DecisionSettings = { ...settings, mode: 'clef', clefModel: 'clef-omni' };
    for (const surface of ['toolPick', 'intake', 'paneState', 'rank'] as const) {
      expect(resolveDecisionRoute({ surface }, omni, both)).toMatchObject({ provider: 'clef', model: 'clef-omni' });
    }
    expect(resolveDecisionRoute({ model: 'clef' }, omni, both)).toBeNull();
  });

  it('uses clef-omni for the masked browser visual judgment when selected', () => {
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    const omniVision: DecisionSettings = { ...settings, mode: 'clef', clefModel: 'clef-omni', visionEnabled: true, visionConsent };
    expect(resolveDecisionRoute({ surface: 'browserTool', images }, omniVision, both)).toMatchObject({ provider: 'clef', model: 'clef-omni', reason: 'vision' });
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

  const lunaOn = { jev: true, clef: true, luna: true };
  const lunaMode: DecisionSettings = { ...settings, mode: 'luna' };

  it('sends unpinned text to Luna in Luna-only mode and does not fall back when the key is missing', () => {
    for (const surface of ['toolPick', 'intake', 'missionPick', 'catalogPick'] as const) {
      expect(resolveDecisionRoute({ surface }, lunaMode, lunaOn)).toMatchObject({ provider: 'luna', model: 'gpt-6-luna', evidence: 'manual' });
      expect(resolveDecisionRoute({ surface }, lunaMode, { jev: true, clef: true })).toBeNull();
    }
    expect(resolveDecisionRoute({}, { ...settings, mode: 'luna' }, { jev: true, clef: true, luna: false })).toBeNull();
  });

  it('sends pinned surfaces to Luna when the operator chose Luna, and does not fall back to Jev', () => {
    for (const surface of ['dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool', 'browserTool'] as const) {
      expect(resolveDecisionRoute({ surface }, lunaMode, lunaOn)).toMatchObject({ provider: 'luna', model: 'gpt-6-luna', reason: 'operator-override' });
      expect(resolveDecisionRoute({ surface }, lunaMode, { jev: true, clef: true, luna: false })).toBeNull();
      expect(resolveDecisionRoute({ surface, model: 'gpt-6-luna' }, settings, lunaOn)).toBeNull();
    }
  });

  it('runs the three together only as a real ensemble, and keeps labels on Jev', () => {
    const together = { ...settings, mode: 'together' as const };
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(ensembleMembers({ surface: 'dispatchGuard' }, together, lunaOn)?.map(member => member.provider)).toEqual(['jev', 'luna', 'clef']);
    expect(ensembleMembers({ surface: 'dispatchGuard' }, together, { jev: true, clef: false, luna: true })?.map(member => member.provider)).toEqual(['jev', 'luna']);
    expect(ensembleMembers({ surface: 'dispatchGuard' }, together, { jev: true, clef: true, luna: false })?.map(member => member.provider)).toEqual(['jev', 'clef']);
    expect(ensembleMembers({ surface: 'dispatchGuard' }, together, { jev: false, clef: false, luna: true })).toBeNull();
    expect(ensembleMembers({ surface: 'dispatchGuard' }, together, { jev: false, clef: true, luna: true })?.map(member => member.provider)).toEqual(['luna', 'clef']);
    expect(ensembleMembers({ surface: 'taskRouting' }, together, lunaOn)?.map(member => member.provider)).toEqual(['jev', 'luna']);
    expect(ensembleMembers({ surface: 'catalogPick' }, together, { jev: false, clef: true, luna: true })?.map(member => member.provider)).toEqual(['luna', 'clef']);
    expect(ensembleMembers({ surface: 'taskRouting' }, together, { jev: false, clef: false, luna: true })).toBeNull();
    expect(resolveDecisionRoute({ surface: 'dispatchGuard' }, together, { jev: false, clef: true, luna: true })?.provider).toBe('luna');
    expect(resolveDecisionRoute({ surface: 'computerTool' }, together, lunaOn)).toMatchObject({ provider: 'jev', reason: 'labels' });
    expect(resolveDecisionRoute({ surface: 'browserTool' }, together, lunaOn)).toMatchObject({ provider: 'jev', reason: 'labels' });
    expect(resolveDecisionRoute({ surface: 'computerTool' }, together, { jev: false, clef: true, luna: true })).toBeNull();
    expect(ensembleMembers({ surface: 'browserTool', images }, { ...together, visionEnabled: true, visionConsent }, lunaOn)?.map(member => member.provider)).toEqual(['luna', 'clef']);
    expect(ensembleMembers({ surface: 'computerTool', images }, { ...together, visionEnabled: true, visionConsent }, lunaOn)).toBeNull();
    expect(resolveDecisionRoute({ surface: 'dispatchGuard', model: 'gpt-6-luna' }, together, lunaOn)?.provider).toBe('jev');
  });

  it('uses Luna in automatic mode only when the preferred providers are missing', () => {
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, { jev: true, clef: false, luna: true })).toMatchObject({ provider: 'jev', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'intake' }, settings, { jev: false, clef: true, luna: true })).toMatchObject({ provider: 'clef', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'intake' }, settings, { jev: false, clef: false, luna: true })).toMatchObject({ provider: 'luna', model: 'gpt-6-luna', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ surface: 'toolPick' }, settings, { jev: false, clef: false, luna: true })).toMatchObject({ provider: 'luna', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ model: 'gpt-6-luna' }, settings, lunaOn)).toMatchObject({ provider: 'luna', reason: 'explicit-model' });
    expect(resolveDecisionRoute({ model: 'gpt-6-luna' }, { ...settings, mode: 'jev' }, lunaOn)).toBeNull();
    expect(resolveDecisionRoute({ model: 'jev-latest' }, lunaMode, lunaOn)).toMatchObject({ provider: 'luna', reason: 'manual' });
  });

  it('keeps pre-Luna visual consent limited to Cloudflare on upgrade and credential fallback', () => {
    const legacy = decisionSettingsSchema.parse({ ...settings, visionEnabled: true });
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(resolveDecisionRoute({ surface: 'browserTool', images }, legacy, lunaOn)?.provider).toBe('clef');
    expect(resolveDecisionRoute({ surface: 'browserTool', images }, legacy, { jev: true, clef: false, luna: true })).toBeNull();
    expect(canRouteBrowserVisual(legacy, { jev: true, clef: false, luna: true })).toBe(false);
    expect(resolveDecisionRoute({ surface: 'browserTool', images, model: 'gpt-6-luna' }, legacy, lunaOn)).toBeNull();
  });

  it.each(['luna', 'together'] as const)('mode switch to %s cannot expand old Cloudflare consent', mode => {
    const legacy = decisionSettingsSchema.parse({ ...settings, mode: 'clef', visionEnabled: true });
    const switched = decisionSettingsSchema.parse({ ...legacy, mode });
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(resolveDecisionRoute({ surface: 'browserTool', images }, switched, lunaOn)).toBeNull();
    expect(canRouteBrowserVisual(switched, lunaOn)).toBe(false);
    expect(resolveDecisionRoute({ surface: 'intake' }, switched, lunaOn)).not.toBeNull();
  });

  it('sends browser images to Luna when that is the vision route, and never desktop pixels', () => {
    const images = [{ content_type: 'image/png' as const, base64: 'synthetic' }];
    expect(resolveDecisionRoute({ surface: 'browserTool', images }, { ...lunaMode, visionEnabled: true, visionConsent }, lunaOn)).toMatchObject({ provider: 'luna', evidence: 'capability' });
    expect(resolveDecisionRoute({ images }, { ...settings, visionEnabled: true, visionConsent }, { jev: false, clef: false, luna: true })).toMatchObject({ provider: 'luna', reason: 'credential-fallback' });
    expect(resolveDecisionRoute({ images }, { ...lunaMode, visionEnabled: true, visionConsent }, { jev: true, clef: true })).toBeNull();
    expect(resolveDecisionRoute({ surface: 'computerTool', images }, { ...lunaMode, visionEnabled: true, visionConsent }, lunaOn)).toBeNull();
    expect(resolveDecisionRoute({ surface: 'intake' }, settings, both)?.policyVersion).toBe('jev-clef-luna-v1');
    expect(canRouteBrowserVisual({ ...settings, visionEnabled: true, visionConsent }, both)).toBe(true);
    expect(canRouteBrowserVisual({ ...settings, visionEnabled: true, visionConsent }, { jev: true, clef: false, luna: true })).toBe(true);
    expect(canRouteBrowserVisual({ ...lunaMode, visionEnabled: true, visionConsent }, lunaOn)).toBe(true);
    expect(canRouteBrowserVisual({ ...settings, mode: 'clef', visionEnabled: true, visionConsent }, { jev: false, clef: false, luna: true })).toBe(false);
    expect(canRouteBrowserVisual({ ...settings, mode: 'jev', visionEnabled: true, visionConsent }, lunaOn)).toBe(false);
  });
});
