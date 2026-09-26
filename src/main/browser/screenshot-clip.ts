import type { BrowserDesignRect } from '../../shared/browser-design';

/**
 * Element-screenshot clipping (VISUAL-EDIT-001, Fase 1). Selection rects come
 * from the page in CSS pixels — the same unit `webContents.capturePage`
 * expects for its clip — so no DPI math is needed on any platform. Returns
 * null when nothing meaningful is visible (caller falls back to a full-pane
 * capture).
 */

export interface ScreenshotViewport {
  width: number;
  height: number;
}

export interface ClampClipOptions {
  /** Extra context around the element, still clamped to the viewport. */
  padding?: number;
}

export function clampScreenshotClip(
  rect: BrowserDesignRect,
  viewport: ScreenshotViewport,
  options: ClampClipOptions = {},
): { x: number; y: number; width: number; height: number } | null {
  if (viewport.width < 1 || viewport.height < 1) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const padding = Math.max(0, options.padding ?? 0);
  const x0 = Math.max(0, Math.floor(rect.x - padding));
  const y0 = Math.max(0, Math.floor(rect.y - padding));
  const x1 = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding));
  const y1 = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 1 || height < 1) return null;
  return { x: x0, y: y0, width, height };
}

/** Structural slice of Electron's NativeImage that a capture needs. */
export interface CapturedImage {
  getSize(): { width: number; height: number };
}

export const HIDDEN_CAPTURE_RETRY_MS = 150;

/**
 * Página que carregou com a vista escondida (projeto fora da tela, F-168;
 * painel sob um overlay) ainda não tem quadro: a primeira captura falha na
 * hora ("UnknownVizError") e acorda o renderer; a seguinte, logo depois, sai
 * com a página atual — medido no Electron, sem quadro velho.
 */
export async function captureWithWakeRetry<T extends CapturedImage>(
  capture: () => Promise<T>,
  beforeRetry: () => void = () => {},
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  try {
    const image = await capture();
    const size = image.getSize();
    if (size.width > 0 && size.height > 0) return image;
  } catch {
    // Sem quadro ainda: a segunda tentativa decide e propaga o próprio erro.
  }
  await wait(HIDDEN_CAPTURE_RETRY_MS);
  beforeRetry();
  return capture();
}
