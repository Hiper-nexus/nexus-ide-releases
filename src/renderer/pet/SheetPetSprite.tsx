import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SHEET_ANIMS,
  SHEET_NEUTRAL,
  type PetSheet,
} from '../../shared/pet-types';

/**
 * Sprite de spritesheet Codex v2: anima recortando frames do sheet num
 * canvas. `anim` escolhe a linha do contrato (idle/wave/failed); dormindo
 * congela no frame neutro. Reduced-motion: frame estático.
 */

export type SheetAnim = 'idle' | 'wave' | 'failed' | 'sleep';

interface SheetPetSpriteProps {
  sheet: PetSheet;
  anim: SheetAnim;
  /** Altura de exibição em px; a largura segue a proporção do frame. */
  size: number;
}

const FRAME_MS = 140;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function SheetPetSprite({ sheet, anim, size }: SheetPetSpriteProps) {
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

  const spec = useMemo(() => {
    if (anim === 'sleep') return { row: SHEET_NEUTRAL.row, frames: 1 };
    return SHEET_ANIMS[anim];
  }, [anim]);

  useEffect(() => {
    setFrame(0);
    if (spec.frames <= 1 || prefersReducedMotion()) return undefined;
    const timer = window.setInterval(
      () => setFrame((f) => (f + 1) % spec.frames),
      FRAME_MS,
    );
    return () => window.clearInterval(timer);
  }, [spec]);

  const frameW = image ? image.width / sheet.cols : 1;
  const frameH = image ? image.height / sheet.rows : 1;
  const displayW = Math.round((frameW / frameH) * size);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image) return;
    const col = anim === 'sleep' ? SHEET_NEUTRAL.col : frame;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      image,
      col * frameW,
      spec.row * frameH,
      frameW,
      frameH,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, [image, frame, anim, spec, frameW, frameH]);

  return (
    <canvas
      ref={canvasRef}
      width={displayW}
      height={size}
      style={{ width: displayW, height: size }}
      aria-hidden="true"
    />
  );
}
