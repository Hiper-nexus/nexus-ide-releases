import { useEffect, useState } from 'react';
import type { PetPrefs } from '../../shared/pet-types';
import type {
  GamificationTier,
  OperatorBranch,
} from '../../shared/gamification-types';
import { CustomPetSprite } from '../pet/CustomPetSprite';
import { SheetPetSprite, type SheetAnim } from '../pet/SheetPetSprite';
import { OperatorSprite, type OperatorMood } from './OperatorSprite';

/**
 * Retrato do pet que o cliente escolheu em Definições (sheet / custom / preset).
 * Usado no perfil de Operador, HUD e FX — a identidade visual é o companion,
 * não o robot genérico da gamificação.
 */

interface ChosenPetPortraitProps {
  size: number;
  mood?: OperatorMood;
  /** Fallback enquanto as prefs do pet carregam (ou se o API falhar). */
  fallbackTier?: GamificationTier;
  fallbackBranch?: OperatorBranch;
  fallbackSkin?: string | null;
  className?: string;
}

function spriteSkinForPreset(preset: PetPrefs['preset']): string | null {
  return preset === 'operator' || preset === 'custom' || preset === 'sheet'
    ? null
    : preset;
}

function sheetAnimForMood(mood: OperatorMood): SheetAnim {
  switch (mood) {
    case 'celebrating':
    case 'evolving':
      return 'wave';
    case 'sleeping':
      return 'sleep';
    default:
      return 'idle';
  }
}

export function ChosenPetPortrait({
  size,
  mood = 'idle',
  fallbackTier = 'RECRUTA',
  fallbackBranch = 'base',
  fallbackSkin = null,
  className,
}: ChosenPetPortraitProps) {
  const [prefs, setPrefs] = useState<PetPrefs | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = window.nexus?.pet;
    if (!api?.getPrefs) return undefined;
    void api.getPrefs().then((loaded) => {
      if (!cancelled) setPrefs(loaded);
    });
    const off = api.onPrefsChanged?.((next) => {
      if (!cancelled) setPrefs(next);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const body =
    prefs?.preset === 'sheet' && prefs.sheet ? (
      <SheetPetSprite
        sheet={prefs.sheet}
        anim={sheetAnimForMood(mood)}
        size={size}
      />
    ) : prefs?.preset === 'custom' && prefs.customGrid ? (
      <CustomPetSprite grid={prefs.customGrid} size={size} />
    ) : (
      <OperatorSprite
        size={size}
        tier={fallbackTier}
        branch={fallbackBranch}
        skin={
          prefs
            ? spriteSkinForPreset(prefs.preset)
            : fallbackSkin
        }
        mood={mood}
      />
    );

  if (!className) return body;
  return <span className={className}>{body}</span>;
}
