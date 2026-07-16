import { DESIGN_CHARTER } from './design-charter';
import {
  DESIGN_DIAL_NEUTRAL,
  type OrchSettings,
} from '../../shared/settings-types';

/**
 * Perfil de design do motor automático: modula a Carta de Design com uma
 * direção estética e três dials 1–10 (conceito e taxonomia adaptados do
 * taste-skill, MIT — github.com/leonxlnx/taste-skill; texto original nosso).
 * A composição é pura e frugal: perfil neutro devolve a carta intocada (zero
 * bytes extras no prompt), e cada dial só vira linha quando sai da banda
 * neutra. As proibições absolutas da carta SEMPRE vencem o perfil.
 */
export type DesignProfile = Partial<
  Pick<
    OrchSettings,
    'designDirection' | 'designVariance' | 'designMotion' | 'designDensity'
  >
>;

const DIRECTION_BRIEFS: Record<string, string> = {
  minimalist:
    'Aesthetic direction: MINIMALIST. Reduce every screen to its essential ' +
    'elements — when in doubt, remove. Negative space is the primary ' +
    'structure; hierarchy comes from type scale and weight, not boxes or ' +
    'borders. Near-monochrome palette with at most one committed accent. No ' +
    'decorative shadows, dividers or ornaments.',
  brutalist:
    'Aesthetic direction: BRUTALIST. Raw structural honesty: flat blocks of ' +
    'solid color, hard edges (no border-radius), visible grid, stark ' +
    'contrast with loud accents. Dense grotesque or mono type; oversized ' +
    'headings welcome. No soft shadows, no gradients — but accessibility ' +
    '(contrast, focus states, reduced motion) still applies in full.',
  soft:
    'Aesthetic direction: SOFT. Calm, approachable surfaces: gently rounded ' +
    'geometry, low-saturation warm palettes (body contrast still ≥ 4.5:1), ' +
    'diffuse layered shadows instead of hard borders, fluid ease-out motion ' +
    'and supportive plain-language copy. Softness must NOT drift into the ' +
    'banned blur/glassmorphism-by-default look.',
};

type DialBand = 'low' | 'neutral' | 'high';

interface DialSpec {
  key: 'designVariance' | 'designMotion' | 'designDensity';
  low: string;
  high: string;
}

const DIAL_SPECS: DialSpec[] = [
  {
    key: 'designVariance',
    low:
      'stick to proven, conventional layout patterns; predictability beats ' +
      'novelty here.',
    high:
      'break the default template deliberately — asymmetry, overlap, ' +
      'editorial composition — while keeping scanability and usability intact.',
  },
  {
    key: 'designMotion',
    low:
      'essentially static UI; transitions only where they carry meaning ' +
      '(state changes), nothing decorative.',
    high:
      'choreograph entrances, transitions and micro-interactions as part of ' +
      'the experience — still ease-out, still honoring prefers-reduced-motion.',
  },
  {
    key: 'designDensity',
    low: 'one idea per viewport; generous spacing; let the content breathe.',
    high:
      'information-dense professional UI — compact spacing, tabular clarity, ' +
      'more data per viewport without flattening the hierarchy.',
  },
];

const DIAL_LABELS: Record<DialSpec['key'], string> = {
  designVariance: 'Layout variance',
  designMotion: 'Motion intensity',
  designDensity: 'Visual density',
};

/** Settings antigos/mocks podem trazer dial ausente ou fora da faixa. */
export function clampDial(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DESIGN_DIAL_NEUTRAL;
  }
  return Math.min(10, Math.max(1, Math.round(value)));
}

function dialBand(dial: number): DialBand {
  if (dial <= 3) return 'low';
  if (dial >= 8) return 'high';
  return 'neutral';
}

/**
 * Compõe a Carta de Design efetiva para um worker de UI. Perfil neutro
 * (direção `auto`, dials na banda 4–7) devolve exatamente a DESIGN_CHARTER —
 * o caminho quente de todo spawn não paga nada pelo recurso.
 */
export function composeDesignCharter(profile: DesignProfile = {}): string {
  const lines: string[] = [];

  const direction = DIRECTION_BRIEFS[profile.designDirection ?? 'auto'];
  if (direction) lines.push(direction);

  for (const spec of DIAL_SPECS) {
    const dial = clampDial(profile[spec.key]);
    const band = dialBand(dial);
    if (band === 'neutral') continue;
    lines.push(`${DIAL_LABELS[spec.key]} ${dial}/10: ${spec[band]}`);
  }

  if (lines.length === 0) return DESIGN_CHARTER;

  return (
    `${DESIGN_CHARTER}\n\n` +
    '## Design profile (workspace setting)\n' +
    'The absolute bans above always win; this profile only steers taste ' +
    'within them.\n' +
    lines.map((line) => `- ${line}`).join('\n')
  );
}
