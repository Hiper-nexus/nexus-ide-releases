import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

/**
 * Chave interna do estúdio de vídeo (`feature.media.videoStudio`, desligada por
 * padrão). Lida a cada chamada: ligar ou desligar em Ajustes → Experimental vale
 * na hora, sem reiniciar. Registro indisponível conta como desligado.
 */
export function isVideoStudioEnabled(): boolean {
  try {
    return getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.mediaVideoStudio);
  } catch {
    return false;
  }
}

export const VIDEO_STUDIO_DISABLED_REASON =
  'o estúdio de vídeo está desligado. Ligue "Estúdio de vídeo (em validação)" em Ajustes → Experimental';

export function assertVideoStudioEnabled(): void {
  if (!isVideoStudioEnabled()) throw new Error(VIDEO_STUDIO_DISABLED_REASON);
}
