import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry, resetFeatureFlagRegistryForTests } from '../feature-flags/feature-flag-registry';
import { isBundledSkillAvailable } from '../orch/skill-mirror';
import { assertVideoStudioEnabled, isVideoStudioEnabled } from './video-studio-flag';

/** F-1600 — o estúdio de vídeo fica atrás de uma chave interna até o passo 17. */

afterEach(() => {
  resetFeatureFlagRegistryForTests();
});

describe('chave interna do estúdio de vídeo', () => {
  it('nasce desligada e recusa com o caminho para ligar', () => {
    expect(isVideoStudioEnabled()).toBe(false);
    expect(() => assertVideoStudioEnabled()).toThrow(/Ajustes → Experimental/u);
    expect(isBundledSkillAvailable('nexus-video')).toBe(false);
  });

  it('o override do operador liga e desliga na hora, sem reiniciar', () => {
    const registry = getFeatureFlagRegistry();
    registry.setOverride(FEATURE_FLAG_IDS.mediaVideoStudio, true);
    expect(isVideoStudioEnabled()).toBe(true);
    expect(() => assertVideoStudioEnabled()).not.toThrow();
    expect(isBundledSkillAvailable('nexus-video')).toBe(true);
    registry.setOverride(FEATURE_FLAG_IDS.mediaVideoStudio, false);
    expect(isVideoStudioEnabled()).toBe(false);
  });

  it('as outras skills embutidas não dependem da chave', () => {
    expect(isBundledSkillAvailable('superpowers')).toBe(true);
    expect(isBundledSkillAvailable('oc-builder')).toBe(true);
  });
});
