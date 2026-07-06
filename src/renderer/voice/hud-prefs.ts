/**
 * Preferências do HUD da JARVIS — modo de exibição, âncora de canto e tamanho.
 *
 * O HUD antigo era fixo no canto inferior-direito com ~440px, tampando o
 * terminal ("ela fica enorme embaixo"). Agora ele é arrastável (solta e ancora
 * no canto mais próximo), redimensionável, minimizável (pill) e ocultável
 * (modo só-áudio: a voz segue funcionando sem visual nenhum).
 *
 * Persistência em localStorage (estado de UI local da janela, como o layout).
 * Módulo puro — DOM/Storage entram por parâmetro, testável sem browser.
 */

export type HudMode = 'expanded' | 'mini' | 'hidden';
export type HudCorner = 'tl' | 'tr' | 'bl' | 'br';

export interface HudPrefs {
  mode: HudMode;
  corner: HudCorner;
  /** Distância horizontal (px) da borda do canto ancorado. */
  dx: number;
  /** Distância vertical (px) da borda do canto ancorado. */
  dy: number;
  /** Largura do painel expandido (px). */
  width: number;
}

export const HUD_MIN_WIDTH = 240;
export const HUD_MAX_WIDTH = 480;
/** Folga mínima da borda da janela ao ancorar. */
export const HUD_EDGE_MARGIN = 8;

export const DEFAULT_HUD_PREFS: HudPrefs = {
  mode: 'expanded',
  corner: 'br',
  dx: 20,
  dy: 20,
  width: 300,
};

const STORAGE_KEY = 'nexus.voiceHud';

export function clampHudWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_HUD_PREFS.width;
  return Math.min(HUD_MAX_WIDTH, Math.max(HUD_MIN_WIDTH, Math.round(width)));
}

/** Canto mais próximo do CENTRO do elemento (metades do viewport). */
export function nearestCorner(
  centerX: number,
  centerY: number,
  viewportWidth: number,
  viewportHeight: number,
): HudCorner {
  const vertical = centerY < viewportHeight / 2 ? 't' : 'b';
  const horizontal = centerX < viewportWidth / 2 ? 'l' : 'r';
  return `${vertical}${horizontal}` as HudCorner;
}

export interface DragRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Converte a posição solta do drag em âncora de canto + offsets, clampando
 * para dentro do viewport (nunca ancora fora da tela — mesma proteção do
 * "re-anchored to monitor" do BridgeVoice).
 */
export function anchorFromDrag(
  rect: DragRect,
  viewport: { width: number; height: number },
): Pick<HudPrefs, 'corner' | 'dx' | 'dy'> {
  const corner = nearestCorner(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    viewport.width,
    viewport.height,
  );
  const rawDx = corner.endsWith('l')
    ? rect.left
    : viewport.width - (rect.left + rect.width);
  const rawDy = corner.startsWith('t')
    ? rect.top
    : viewport.height - (rect.top + rect.height);
  const maxDx = Math.max(HUD_EDGE_MARGIN, viewport.width - rect.width - HUD_EDGE_MARGIN);
  const maxDy = Math.max(HUD_EDGE_MARGIN, viewport.height - rect.height - HUD_EDGE_MARGIN);
  return {
    corner,
    dx: Math.round(Math.min(maxDx, Math.max(HUD_EDGE_MARGIN, rawDx))),
    dy: Math.round(Math.min(maxDy, Math.max(HUD_EDGE_MARGIN, rawDy))),
  };
}

/** Estilo de posição fixa (px) a partir da âncora. */
export function hudPositionStyle(
  prefs: Pick<HudPrefs, 'corner' | 'dx' | 'dy'>,
): { left?: number; right?: number; top?: number; bottom?: number } {
  return {
    ...(prefs.corner.endsWith('l') ? { left: prefs.dx } : { right: prefs.dx }),
    ...(prefs.corner.startsWith('t') ? { top: prefs.dy } : { bottom: prefs.dy }),
  };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const MODES: HudMode[] = ['expanded', 'mini', 'hidden'];
const CORNERS: HudCorner[] = ['tl', 'tr', 'bl', 'br'];

export function loadHudPrefs(storage: StorageLike): HudPrefs {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_HUD_PREFS };
    const parsed = JSON.parse(raw) as Partial<HudPrefs>;
    return {
      mode: MODES.includes(parsed.mode as HudMode)
        ? (parsed.mode as HudMode)
        : DEFAULT_HUD_PREFS.mode,
      corner: CORNERS.includes(parsed.corner as HudCorner)
        ? (parsed.corner as HudCorner)
        : DEFAULT_HUD_PREFS.corner,
      dx:
        typeof parsed.dx === 'number' && Number.isFinite(parsed.dx) && parsed.dx >= 0
          ? Math.round(parsed.dx)
          : DEFAULT_HUD_PREFS.dx,
      dy:
        typeof parsed.dy === 'number' && Number.isFinite(parsed.dy) && parsed.dy >= 0
          ? Math.round(parsed.dy)
          : DEFAULT_HUD_PREFS.dy,
      width: clampHudWidth(parsed.width ?? DEFAULT_HUD_PREFS.width),
    };
  } catch {
    return { ...DEFAULT_HUD_PREFS };
  }
}

export function saveHudPrefs(storage: StorageLike, prefs: HudPrefs): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // storage cheio/indisponível — preferência vive só na sessão.
  }
}
