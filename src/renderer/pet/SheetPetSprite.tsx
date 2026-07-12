import { useEffect, useMemo, useRef, useState } from 'react';
import {
  detectSheetGrid,
  SHEET_ANIMS,
  sheetLookFrame,
  type PetSheet,
} from '../../shared/pet-types';

/**
 * Sprite de spritesheet Codex v2: anima recortando frames do sheet num
 * canvas. Paridade visual com o pet do Codex:
 * - malha derivada das dimensões reais (8×9 petdex ou 8×11 v2)
 * - escala **inteira** da célula (192×208 → 1×/2×/3×) — nunca 240px
 *   fracionário, que embraça pixel art e “corta” silhueta
 * - nearest-neighbor (sem smoothing) + image-rendering: pixelated
 */

export type SheetAnim =
  | 'idle'
  | 'run-right'
  | 'run-left'
  | 'wave'
  | 'failed'
  | 'waiting'
  | 'sleep';

interface SheetPetSpriteProps {
  sheet: PetSheet;
  anim: SheetAnim;
  /** Direção do olhar quantizada; só vale durante o idle em sheets 8×11. */
  lookDir?: number | null;
  /**
   * Altura-alvo em CSS px. A altura real usa o múltiplo inteiro da célula
   * mais próximo (sem ultrapassar o alvo, mínimo 1×).
   */
  size: number;
}

const FRAME_MS = 140;
const RUN_FRAME_MS = 80;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Escala de exibição (Codex: células 192×208).
 * - target ≥ célula: múltiplo inteiro (1×/2×/3×) — nítido no desktop.
 * - target < célula (preview): encolhe mantendo aspecto (thumbnails).
 */
export function integerSheetScale(
  frameW: number,
  frameH: number,
  targetH: number,
): { scale: number; displayW: number; displayH: number; integer: boolean } {
  const safeW = Math.max(1, frameW);
  const safeH = Math.max(1, frameH);
  const target = Math.max(1, targetH);
  if (target >= safeH) {
    const scale = Math.max(1, Math.floor(target / safeH));
    return {
      scale,
      displayW: safeW * scale,
      displayH: safeH * scale,
      integer: true,
    };
  }
  const scale = target / safeH;
  return {
    scale,
    displayW: Math.max(1, Math.round(safeW * scale)),
    displayH: Math.max(1, Math.round(safeH * scale)),
    integer: false,
  };
}

export function SheetPetSprite({
  sheet,
  anim,
  lookDir = null,
  size,
}: SheetPetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = sheet.dataUrl;
    return () => {
      img.onload = null;
    };
  }, [sheet.dataUrl]);

  const grid = useMemo(() => {
    if (!image) return { cols: sheet.cols, rows: sheet.rows };
    return detectSheetGrid(image.width, image.height);
  }, [image, sheet.cols, sheet.rows]);

  const looking = useMemo(
    () =>
      anim === 'idle' && lookDir !== null && grid.rows >= 11
        ? sheetLookFrame(lookDir)
        : null,
    [anim, lookDir, grid.rows],
  );

  const spec = useMemo(() => {
    if (anim === 'sleep') {
      return { row: 0, frames: 1, col: 0 as number | null };
    }
    const base = SHEET_ANIMS[anim];
    if (base.row >= grid.rows) {
      return { row: Math.max(0, grid.rows - 1), frames: base.frames, col: null };
    }
    return { ...base, col: null as number | null };
  }, [anim, grid.rows]);

  useEffect(() => {
    setFrame(0);
    if (looking || spec.frames <= 1 || prefersReducedMotion()) return undefined;
    const cadence = anim.startsWith('run-') ? RUN_FRAME_MS : FRAME_MS;
    const timer = window.setInterval(
      () => setFrame((f) => (f + 1) % spec.frames),
      cadence,
    );
    return () => window.clearInterval(timer);
  }, [spec, anim, looking !== null]);

  const frameW = image ? Math.floor(image.width / grid.cols) : 1;
  const frameH = image ? Math.floor(image.height / grid.rows) : 1;
  const { displayW, displayH, integer } = integerSheetScale(
    frameW,
    frameH,
    size,
  );
  const dpr =
    typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image || frameW < 1 || frameH < 1) return;
    const row = looking ? looking.row : spec.row;
    const maxCol = Math.max(0, grid.cols - 1);
    const col = looking
      ? looking.col
      : spec.col !== null && spec.col !== undefined
        ? Math.min(spec.col, maxCol)
        : Math.min(frame, maxCol);

    // Buffer em device pixels; desenhamos em CSS px com transform dpr.
    canvas.width = Math.max(1, Math.round(displayW * dpr));
    canvas.height = Math.max(1, Math.round(displayH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);
    // Escala inteira: nearest (paridade Codex). Thumb fractional: high quality.
    ctx.imageSmoothingEnabled = !integer;
    if (ctx.imageSmoothingEnabled) {
      ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(
      image,
      col * frameW,
      row * frameH,
      frameW,
      frameH,
      0,
      0,
      displayW,
      displayH,
    );
  }, [
    image,
    frame,
    anim,
    spec,
    looking,
    frameW,
    frameH,
    displayW,
    displayH,
    integer,
    dpr,
    grid.cols,
    grid.rows,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: displayW,
        height: displayH,
        imageRendering: integer ? 'pixelated' : 'auto',
      }}
      aria-hidden="true"
    />
  );
}
