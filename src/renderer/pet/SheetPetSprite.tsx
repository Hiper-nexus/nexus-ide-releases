import { useEffect, useMemo, useRef, useState } from 'react';
import {
  detectSheetGrid,
  SHEET_ANIMS,
  SHEET_NEUTRAL,
  sheetLookFrame,
  type PetSheet,
} from '../../shared/pet-types';

/**
 * Sprite de spritesheet Codex v2: anima recortando frames do sheet num
 * canvas. `anim` escolhe a linha do contrato (idle/wave/failed); dormindo
 * congela no frame neutro. `lookDir` (0..15) sobrepõe o idle com o frame
 * direcional das linhas de look — o pet segue o cursor. Reduced-motion:
 * frame estático (o look continua, é postura, não animação).
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
  /** Direção do olhar quantizada; só vale durante o idle. */
  lookDir?: number | null;
  /** Altura de exibição em px; a largura segue a proporção do frame. */
  size: number;
}

const FRAME_MS = 140;
/** Corrida tem cadência mais viva que o idle. */
const RUN_FRAME_MS = 80;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
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

  // Sempre deriva a malha das dimensões reais da imagem.
  // Prefs antigas podem ter rows:11 gravado num sheet petdex 8×9 — e
  // 1872%11≠0 mas 936%11≠0; mesmo quando “divide exacto” (ex. half-res
  // errado), a razão da célula canónica 192:208 manda mais do que o
  // metadata stale.
  const grid = useMemo(() => {
    if (!image) return { cols: sheet.cols, rows: sheet.rows };
    return detectSheetGrid(image.width, image.height);
  }, [image, sheet.cols, sheet.rows]);

  // Look só sobrepõe o IDLE e exige as linhas 9–10 (Codex v2 completo).
  const looking = useMemo(
    () =>
      anim === 'idle' && lookDir !== null && grid.rows >= 11
        ? sheetLookFrame(lookDir)
        : null,
    [anim, lookDir, grid.rows],
  );

  const spec = useMemo(() => {
    if (anim === 'sleep') {
      // Col 6 do Codex full é o neutro; em packs petdex 8×9 costuma ser vazio.
      return { row: 0, frames: 1, col: 0 as number | null };
    }
    const base = SHEET_ANIMS[anim];
    // Sheets com menos de 11 linhas (ex.: petdex 8×9) — clampa a row válida.
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

  // Integer cell size — fractional width/cols drifts and crops frames over rows.
  const frameW = image ? Math.floor(image.width / grid.cols) : 1;
  const frameH = image ? Math.floor(image.height / grid.rows) : 1;
  const displayW = Math.max(
    1,
    Math.round((frameW / Math.max(frameH, 1)) * size),
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
    const cssW = displayW;
    const cssH = size;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Sheets Codex/petdex são arte pintada em alta res (não pixel 16×16).
    // Suavizar o scale evita o aspecto “bloco/corte” ao ampliar o frame.
    const integerScale =
      cssW % frameW === 0 &&
      cssH % frameH === 0 &&
      cssW / frameW === cssH / frameH;
    ctx.imageSmoothingEnabled = !integerScale;
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
      cssW,
      cssH,
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
    size,
    dpr,
    grid.cols,
    grid.rows,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: displayW, height: size, imageRendering: 'auto' }}
      aria-hidden="true"
    />
  );
}
