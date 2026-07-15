import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  detectSheetGrid,
  SHEET_ANIMS,
  sheetLookFrame,
  type PetSheet,
} from "../../shared/pet-types";

/**
 * Sprite de spritesheet Codex v2: anima recortando frames do sheet num
 * canvas. Paridade visual com o pet do Codex:
 * - malha derivada das dimensões reais (8×9 petdex ou 8×11 v2)
 * - escala: pixel-art = nearest; sheets full-res 3D = high-quality smooth
 * - não reinicia o loop ao só inverter corrida L↔R (evita “piscar”)
 * - ignora colunas vazias no fim da linha (packs petdex)
 */

export type SheetAnim =
  "idle" | "run-right" | "run-left" | "wave" | "failed" | "waiting" | "sleep";

interface SheetPetSpriteProps {
  sheet: PetSheet;
  anim: SheetAnim;
  /** Direção do olhar quantizada; só vale durante o idle em sheets 8×11. */
  lookDir?: number | null;
  /** Altura-alvo em CSS px. */
  size: number;
  /** Mantém o frame atual durante o drag para não repintar a janela em movimento. */
  paused?: boolean;
}

const FRAME_MS = 140;
/** Idle sheets need a readable pose, not a rapid flipbook. */
const IDLE_FRAME_MS = 480;
/** Corrida — packs petdex têm frames bem distintos. */
const RUN_FRAME_MS = 100;

interface SpriteCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Escala de exibição (célula Codex 192×208).
 * - Células grandes (full-res / 3D): smooth high — nearest deixa “sujo”
 * - Células pequenas (pixel art ≤64): nearest / pixelated
 */
export function integerSheetScale(
  frameW: number,
  frameH: number,
  targetH: number,
): { scale: number; displayW: number; displayH: number; integer: boolean } {
  const safeW = Math.max(1, frameW);
  const safeH = Math.max(1, frameH);
  const target = Math.max(1, targetH);
  /** Pixel-art clássico; 192px (Codex full-res) deve usar smooth. */
  const pixelArt = safeW <= 64 && safeH <= 64;

  if (target >= safeH * 2) {
    const scale = Math.max(2, Math.floor(target / safeH));
    return {
      scale,
      displayW: safeW * scale,
      displayH: safeH * scale,
      integer: pixelArt,
    };
  }
  if (target > safeH) {
    const scale = target / safeH;
    return {
      scale,
      displayW: Math.max(1, Math.round(safeW * scale)),
      displayH: Math.max(1, Math.round(safeH * scale)),
      integer: pixelArt,
    };
  }
  if (target === safeH) {
    return { scale: 1, displayW: safeW, displayH: safeH, integer: pixelArt };
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
  if (anim === "run-left" || anim === "run-right") return "run";
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
  const canvas = document.createElement("canvas");
  canvas.width = frameW;
  canvas.height = frameH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || frameW < 1 || frameH < 1) return Math.max(1, maxFrames);
  let count = 0;
  const detachedArtifact: boolean[] = [];
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
    for (let i = 3; i < data.length; i += 16) {
      if (data[i]! > 24) {
        opaque += 1;
        if (opaque > 8) break;
      }
    }
    if (opaque <= 8) break;
    detachedArtifact.push(hasDetachedHorizontalArtifact(data, frameW, frameH));
    count += 1;
  }

  /*
   * Alguns sheets gerados chegam com um fragmento do frame vizinho somente
   * no último passo (ex.: uma segunda tampa do notebook fora do personagem).
   * Remover apenas caudas contaminadas conserva todos os passos válidos e
   * evita desenhar esse fragmento como se fosse parte da animação.
   */
  while (count > 1 && detachedArtifact[count - 1]) count -= 1;
  return Math.max(1, count);
}

interface AlphaComponent {
  pixels: number;
  minX: number;
  maxX: number;
}

/** Detecta pequenos fragmentos alpha separados horizontalmente do corpo. */
function hasDetachedHorizontalArtifact(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  const visited = new Uint8Array(width * height);
  const components: AlphaComponent[] = [];
  const stack: number[] = [];

  for (let origin = 0; origin < width * height; origin += 1) {
    if (visited[origin] || rgba[origin * 4 + 3]! <= 24) continue;
    visited[origin] = 1;
    stack.push(origin);
    let pixels = 0;
    let minX = width;
    let maxX = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = Math.floor(index / width);
      pixels += 1;
      if (x < minX) minX = x;
      if (x + 1 > maxX) maxX = x + 1;

      const visit = (next: number) => {
        if (visited[next] || rgba[next * 4 + 3]! <= 24) return;
        visited[next] = 1;
        stack.push(next);
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }

    if (pixels >= 20) components.push({ pixels, minX, maxX });
  }

  if (components.length < 2) return false;
  components.sort((a, b) => b.pixels - a.pixels);
  const body = components[0]!;
  if (body.pixels < 1_000) return false;
  return components
    .slice(1)
    .some(
      (part) =>
        part.pixels < body.pixels * 0.08 &&
        (part.maxX <= body.minX || part.minX >= body.maxX),
    );
}

/**
 * Bounding box alpha comum a uma família. Para corrida, as duas direções e
 * todos os passos partilham o mesmo recorte: as pernas animam sem a largura do
 * canvas oscilar. A margem transparente gigantesca do atlas não vira hitbox.
 */
function opaqueFamilyCrop(
  image: HTMLImageElement,
  rows: readonly number[],
  cols: number,
  frameW: number,
  frameH: number,
  framesByRow: readonly number[],
): SpriteCrop {
  const scratch = document.createElement("canvas");
  scratch.width = frameW;
  scratch.height = frameH;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx || frameW < 1 || frameH < 1) {
    return { x: 0, y: 0, width: frameW, height: frameH };
  }

  let minX = frameW;
  let minY = frameH;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const frameCount = Math.max(1, Math.min(cols, framesByRow[rowIndex] ?? 1));
    for (let col = 0; col < frameCount; col += 1) {
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
      for (let y = 0; y < frameH; y += 1) {
        for (let x = 0; x < frameW; x += 1) {
          if (data[(y * frameW + x) * 4 + 3]! <= 2) continue;
          found = true;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x + 1 > maxX) maxX = x + 1;
          if (y + 1 > maxY) maxY = y + 1;
        }
      }
    }
  }

  if (!found) return { x: 0, y: 0, width: frameW, height: frameH };
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function SheetPetSprite({
  sheet,
  anim,
  lookDir = null,
  size,
  paused = false,
}: SheetPetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState(0);
  const familyRef = useRef<string>(animFamily(anim));

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setImage(img);
    };
    img.onerror = () => {
      if (!cancelled) setImage(null);
    };
    img.src = sheet.dataUrl;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [sheet.dataUrl]);

  const grid = useMemo(() => {
    if (!image) return { cols: sheet.cols, rows: sheet.rows };
    return detectSheetGrid(image.width, image.height);
  }, [image, sheet.cols, sheet.rows]);

  /**
   * Look só se o caller passar lookDir. PetApp full-res manda null sempre:
   * look muda a pose do notebook (lado ↔ peito) e com drop-shadow/residual
   * o utilizador via “dois notebooks a sair de lado”.
   */
  const looking = useMemo(
    () =>
      anim === "idle" && lookDir !== null && grid.rows >= 11
        ? sheetLookFrame(lookDir)
        : null,
    [anim, lookDir, grid.rows],
  );

  const frameW = image ? Math.floor(image.width / grid.cols) : 1;
  const frameH = image ? Math.floor(image.height / grid.rows) : 1;

  const spec = useMemo(() => {
    if (anim === "sleep") {
      return { row: 0, frames: 1, col: 0 as number | null };
    }
    const base = SHEET_ANIMS[anim];
    const row = base.row >= grid.rows ? Math.max(0, grid.rows - 1) : base.row;
    let frames: number = base.frames;
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

  const isLooking = looking !== null;

  useEffect(() => {
    const family = animFamily(anim);
    if (familyRef.current !== family) {
      familyRef.current = family;
      setFrame(0);
    }
    if (paused || isLooking || spec.frames <= 1 || prefersReducedMotion()) {
      return undefined;
    }
    const cadence =
      family === "run" ? RUN_FRAME_MS : anim === "idle" ? IDLE_FRAME_MS : FRAME_MS;
    const timer = window.setInterval(
      () => setFrame((f) => (f + 1) % spec.frames),
      cadence,
    );
    return () => window.clearInterval(timer);
  }, [spec.frames, anim, isLooking, paused]);

  useEffect(() => {
    setFrame((f) => (spec.frames > 0 ? f % spec.frames : 0));
  }, [spec.frames]);

  const fullDisplay = integerSheetScale(frameW, frameH, size);
  const crop = useMemo(() => {
    if (!image || frameW < 1 || frameH < 1) {
      return { x: 0, y: 0, width: frameW, height: frameH };
    }
    const runFamily = animFamily(anim) === "run";
    const rows = runFamily
      ? [SHEET_ANIMS["run-right"].row, SHEET_ANIMS["run-left"].row].filter(
          (row) => row < grid.rows,
        )
      : [looking?.row ?? spec.row];
    const framesByRow = rows.map((row) =>
      runFamily
        ? countOpaqueColumns(image, row, grid.cols, frameW, frameH, 8)
        : spec.frames,
    );
    return opaqueFamilyCrop(
      image,
      rows,
      grid.cols,
      frameW,
      frameH,
      framesByRow,
    );
  }, [
    image,
    anim,
    looking,
    spec.row,
    spec.frames,
    grid.cols,
    grid.rows,
    frameW,
    frameH,
  ]);
  const displayW = Math.max(1, Math.round(crop.width * fullDisplay.scale));
  const displayH = Math.max(1, Math.round(crop.height * fullDisplay.scale));
  const { integer } = fullDisplay;
  const dpr =
    typeof window !== "undefined"
      ? Math.max(1, window.devicePixelRatio || 1)
      : 1;
  const bufferW = Math.max(1, Math.round(displayW * dpr));
  const bufferH = Math.max(1, Math.round(displayH * dpr));

  /*
   * Dimensiona o backing store somente quando o tamanho realmente muda.
   * Reatribuir canvas.width/height a cada frame destrói a surface transparente
   * por um instante; no WindowServer isso aparece como um flash durante drag.
   */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== bufferW) canvas.width = bufferW;
    if (canvas.height !== bufferH) canvas.height = bufferH;
  }, [bufferW, bufferH]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx || !image || frameW < 1 || frameH < 1) return;
    const row = looking ? looking.row : spec.row;
    const maxCol = Math.max(0, Math.min(grid.cols, spec.frames) - 1);
    const col = looking
      ? looking.col
      : spec.col !== null && spec.col !== undefined
        ? Math.min(spec.col, maxCol)
        : Math.min(frame, maxCol);

    const sx = Math.max(0, Math.floor(col * frameW + crop.x));
    const sy = Math.max(0, Math.floor(row * frameH + crop.y));
    const sw = Math.floor(crop.width);
    const sh = Math.floor(crop.height);

    // `copy` substitui o frame inteiro, inclusive pixels alpha=0, sem destruir
    // e recriar o backing store do canvas.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "copy";
    // Full-res 3D: high quality. Pixel-art: nearest.
    ctx.imageSmoothingEnabled = !integer;
    if (ctx.imageSmoothingEnabled) {
      ctx.imageSmoothingQuality = "high";
    }
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, displayW, displayH);
    ctx.globalCompositeOperation = "source-over";
  }, [
    image,
    frame,
    anim,
    spec,
    looking,
    frameW,
    frameH,
    crop,
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
        imageRendering: integer ? "pixelated" : "auto",
      }}
      aria-hidden="true"
    />
  );
}
