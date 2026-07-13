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
 * - escala estável (1× inteiro, meio-termo fracionário com nearest, 2× se couber)
 * - não reinicia o loop ao só inverter corrida L↔R (evita “piscar”)
 * - ignora colunas vazias no fim da linha (packs petdex)
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
  /** Altura-alvo em CSS px. */
  size: number;
}

/** Idle mais lento: pets 3D (notebook) com frames próximos “somam” no olho. */
const FRAME_MS = 200;
/** Corrida um pouco mais calma — packs petdex têm frames bem distintos. */
const RUN_FRAME_MS = 110;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Escala de exibição (célula Codex 192×208).
 * - ≥2×: múltiplo inteiro (nítido)
 * - entre 1× e 2×: encaixa no alvo com nearest (tamanho confortável no desktop)
 * - <1×: thumbnail
 */
export function integerSheetScale(
  frameW: number,
  frameH: number,
  targetH: number,
): { scale: number; displayW: number; displayH: number; integer: boolean } {
  const safeW = Math.max(1, frameW);
  const safeH = Math.max(1, frameH);
  const target = Math.max(1, targetH);
  if (target >= safeH * 2) {
    const scale = Math.max(2, Math.floor(target / safeH));
    return {
      scale,
      displayW: safeW * scale,
      displayH: safeH * scale,
      integer: true,
    };
  }
  if (target > safeH) {
    const scale = target / safeH;
    return {
      scale,
      displayW: Math.max(1, Math.round(safeW * scale)),
      displayH: Math.max(1, Math.round(safeH * scale)),
      // Fractional mid-scale: still nearest for crisp pixels.
      integer: true,
    };
  }
  if (target === safeH) {
    return { scale: 1, displayW: safeW, displayH: safeH, integer: true };
  }
  const scale = target / safeH;
  return {
    scale,
    displayW: Math.max(1, Math.round(safeW * scale)),
    displayH: Math.max(1, Math.round(safeH * scale)),
    integer: false,
  };
}

/** Família de animação: L/R run partilham o loop de frames. */
function animFamily(anim: SheetAnim): string {
  if (anim === 'run-left' || anim === 'run-right') return 'run';
  return anim;
}

/**
 * Conta quantas colunas do início da linha têm pixels opacos.
 * Petdex deixa slots vazios no fim (idle col 6–7, wave 4–7, …).
 */
function countOpaqueColumns(
  image: HTMLImageElement,
  row: number,
  cols: number,
  frameW: number,
  frameH: number,
  maxFrames: number,
): number {
  const canvas = document.createElement('canvas');
  canvas.width = frameW;
  canvas.height = frameH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || frameW < 1 || frameH < 1) return Math.max(1, maxFrames);
  let count = 0;
  const limit = Math.min(cols, maxFrames);
  for (let col = 0; col < limit; col += 1) {
    ctx.clearRect(0, 0, frameW, frameH);
    ctx.drawImage(
      image,
      col * frameW,
      row * frameH,
      frameW,
      frameH,
      0,
      0,
      frameW,
      frameH,
    );
    const data = ctx.getImageData(0, 0, frameW, frameH).data;
    let opaque = 0;
    // Sample every 4th pixel for speed.
    for (let i = 3; i < data.length; i += 16) {
      if (data[i]! > 24) {
        opaque += 1;
        if (opaque > 8) break;
      }
    }
    if (opaque <= 8) break;
    count += 1;
  }
  return Math.max(1, count);
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
  const familyRef = useRef<string>(animFamily(anim));

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

  const frameW = image ? Math.floor(image.width / grid.cols) : 1;
  const frameH = image ? Math.floor(image.height / grid.rows) : 1;

  const spec = useMemo(() => {
    if (anim === 'sleep') {
      return { row: 0, frames: 1, col: 0 as number | null };
    }
    const base = SHEET_ANIMS[anim];
    const row =
      base.row >= grid.rows ? Math.max(0, grid.rows - 1) : base.row;
    let frames: number = base.frames;
    // Corta colunas vazias no fim (petdex). Só quando a imagem já carregou.
    if (image && frameW > 1 && frameH > 1) {
      frames = countOpaqueColumns(
        image,
        row,
        grid.cols,
        frameW,
        frameH,
        base.frames,
      );
    }
    return { row, frames, col: null as number | null };
  }, [anim, grid.rows, grid.cols, image, frameW, frameH]);

  // Boolean only: lookDir N→N+1 must NOT restart the idle frame timer.
  const isLooking = looking !== null;

  useEffect(() => {
    const family = animFamily(anim);
    // Só reinicia o loop ao mudar de família (idle→run, run→wave…),
    // NÃO ao inverter run-left ↔ run-right — isso causava o “piscar”.
    if (familyRef.current !== family) {
      familyRef.current = family;
      setFrame(0);
    }
    if (isLooking || spec.frames <= 1 || prefersReducedMotion()) return undefined;
    const cadence = family === 'run' ? RUN_FRAME_MS : FRAME_MS;
    const timer = window.setInterval(
      () => setFrame((f) => (f + 1) % spec.frames),
      cadence,
    );
    return () => window.clearInterval(timer);
  }, [spec.frames, anim, isLooking]);

  // Clamp se a linha passou a ter menos frames (sheet/anim).
  useEffect(() => {
    setFrame((f) => (spec.frames > 0 ? f % spec.frames : 0));
  }, [spec.frames]);

  const { displayW, displayH, integer } = integerSheetScale(
    frameW,
    frameH,
    size,
  );
  const dpr =
    typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;

  // Só redimensionar o buffer quando o tamanho muda — `canvas.width = …` a
  // cada frame limpa o bitmap e pisca a janela transparente no macOS.
  const bufferW = Math.max(1, Math.round(displayW * dpr));
  const bufferH = Math.max(1, Math.round(displayH * dpr));

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !ctx || !image || frameW < 1 || frameH < 1) return;
    const row = looking ? looking.row : spec.row;
    const maxCol = Math.max(0, Math.min(grid.cols, spec.frames) - 1);
    const col = looking
      ? looking.col
      : spec.col !== null && spec.col !== undefined
        ? Math.min(spec.col, maxCol)
        : Math.min(frame, maxCol);

    // Source rect inteiro em px de textura (sem subpixel) — half-frame = “dois braços”.
    const sx = Math.max(0, Math.floor(col * frameW));
    const sy = Math.max(0, Math.floor(row * frameH));
    const sw = Math.floor(frameW);
    const sh = Math.floor(frameH);

    if (canvas.width !== bufferW || canvas.height !== bufferH) {
      canvas.width = bufferW;
      canvas.height = bufferH;
    }

    // Clear em coordenadas de DISPOSITIVO (identity). clearRect com
    // setTransform(dpr) em janela transparente no macOS por vezes deixa
    // ghost do frame anterior → notebook/braço “duplicado” na lateral.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // `copy` substitui o destino (não faz alpha-blend com residual).
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = !integer;
    if (ctx.imageSmoothingEnabled) {
      ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, displayW, displayH);
    ctx.globalCompositeOperation = 'source-over';
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
    bufferW,
    bufferH,
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
