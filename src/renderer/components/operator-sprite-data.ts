import type {
  GamificationTier,
  OperatorBranch,
} from '../../shared/gamification-types';

/**
 * Dados PUROS do mascote "o Operador" — pixel art programática 16×16
 * (desenho original: silhueta assimétrica com antena lateral esquerda,
 * visor com entalhes de olhos e núcleo no peito; nenhuma referência a
 * mascotes de terceiros). O componente OperatorSprite renderiza este grid
 * num canvas em escala inteira; a arte bitmap final pode substituir o grid
 * sem mudar a interface.
 *
 * Índices da paleta: 0 transparente · 1 corpo · 2 sombra · 3 visor ·
 * 4 acento · 5 aura.
 */

// prettier-ignore
export const OPERATOR_GRID: number[][] = [
  [0,0,0,5,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,4,0,0,0,0,0,0,0,0,0,5,0,0],
  [0,0,0,1,0,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,0,1,3,3,3,3,3,3,1,2,0,0,0],
  [0,0,0,0,1,3,1,3,3,1,3,1,2,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,2,0,0,0],
  [0,0,0,0,0,2,1,1,1,1,2,0,0,0,0,0],
  [0,0,5,0,1,1,1,1,1,1,1,1,4,0,0,0],
  [0,0,0,1,1,1,1,4,4,1,1,1,1,0,0,0],
  [0,0,0,1,0,1,1,4,4,1,1,2,1,0,0,0],
  [0,0,0,0,0,1,1,1,1,1,2,2,0,0,0,0],
  [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
  [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
  [0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0],
  [0,0,5,0,0,0,0,0,0,0,0,0,0,5,0,0],
];

const TRANSPARENT = 'rgba(0,0,0,0)';
const VISOR = '#38bdf8';

interface BranchStyle {
  body: string;
  shade: string;
  accent: string;
}

/** Corpo/acento por ramo — identidades distintas na mesma silhueta. */
const BRANCH_STYLE: Record<OperatorBranch, BranchStyle> = {
  base: { body: '#94a3b8', shade: '#5f6b81', accent: '#6ea8fe' },
  guardiao: { body: '#86b39b', shade: '#557560', accent: '#34d399' },
  forja: { body: '#b39a86', shade: '#75604f', accent: '#fb923c' },
  scout: { body: '#8fa8b8', shade: '#587082', accent: '#22d3ee' },
};

/** Aura por tier: nasce em VETERANO e intensifica até LENDA (dourada). */
const TIER_AURA: Record<GamificationTier, string> = {
  RECRUTA: TRANSPARENT,
  INICIADO: TRANSPARENT,
  VETERANO: 'rgba(110, 168, 254, 0.45)',
  ELITE: 'rgba(110, 168, 254, 0.8)',
  MAESTRO: '#9db8ff',
  LENDA: '#ffd166',
};

interface SkinOverride extends Partial<BranchStyle> {
  aura?: string;
}

/** Skins desbloocáveis por conquista — sobrepõem a paleta do ramo/tier. */
const SKIN_OVERRIDES: Record<string, SkinOverride> = {
  gold: { body: '#c9b37e', shade: '#8a7a52', accent: '#ffd166' },
  flame: { accent: '#ff6b4a', aura: '#ff8a5c' },
  centurion: { body: '#a8b2c4', shade: '#6d7890', accent: '#e2e8f0' },
  prestige: { accent: '#f8fafc', aura: '#e0e7ff' },
};

/** Paleta final [transparente, corpo, sombra, visor, acento, aura]. */
export function paletteFor(
  tier: GamificationTier,
  branch: OperatorBranch,
  skin: string | null,
): string[] {
  const style = { ...BRANCH_STYLE[branch] };
  let aura = TIER_AURA[tier];
  const override = skin ? SKIN_OVERRIDES[skin] : undefined;
  if (override) {
    if (override.body) style.body = override.body;
    if (override.shade) style.shade = override.shade;
    if (override.accent) style.accent = override.accent;
    if (override.aura) aura = override.aura;
  }
  return [TRANSPARENT, style.body, style.shade, VISOR, style.accent, aura];
}

/** Potência compacta: 999 → '999', 1500 → '1.5K', 35_500_000 → '35.5M'. */
export function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [divisor, suffix] of units) {
    if (abs >= divisor) {
      const value = n / divisor;
      const text =
        Math.abs(value) >= 100
          ? String(Math.round(value))
          : String(Math.round(value * 10) / 10);
      return `${text}${suffix}`;
    }
  }
  return String(n);
}
