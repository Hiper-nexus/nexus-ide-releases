import { useEffect, useMemo, useRef, useState } from 'react';
import {
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

  // Look só sobrepõe o IDLE (wave/failed/sleep têm prioridade) e exige as
  // linhas de look no sheet (contrato v2 completo tem 11 linhas).
  const looking = useMemo(
    () =>
      anim === 'idle' && lookDir !== null && sheet.rows >= 11
        ? sheetLookFrame(lookDir)
        : null,
    [anim, lookDir, sheet.rows],
  );

  const spec = useMemo(() => {
    if (anim === 'sleep') return { row: SHEET_NEUTRAL.row, frames: 1 };
    return SHEET_ANIMS[anim];
  }, [anim]);

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
  const frameW = image ? Math.floor(image.width / sheet.cols) : 1;
  const frameH = image ? Math.floor(image.height / sheet.rows) : 1;
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
    const col = looking
      ? looking.col
      : anim === 'sleep'
        ? SHEET_NEUTRAL.col
        : frame;
    const cssW = displayW;
    const cssH = size;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // Pixel art: never smooth when scaling frames up/down.
    ctx.imageSmoothingEnabled = false;
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
  }, [image, frame, anim, spec, looking, frameW, frameH, displayW, size, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: displayW, height: size, imageRendering: 'pixelated' }}
      aria-hidden="true"
    />
  );
}
