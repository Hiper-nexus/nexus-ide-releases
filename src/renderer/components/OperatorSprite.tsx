import { useEffect, useRef, useState } from 'react';
import type {
  GamificationTier,
  OperatorBranch,
} from '../../shared/gamification-types';
import { OPERATOR_GRID, paletteFor } from './operator-sprite-data';

/**
 * Mascote pixel programático: desenha OPERATOR_GRID num canvas em escala
 * INTEIRA (pixel art nítida). 2 frames de idle (bob de 1px + faísca de aura),
 * desligados com prefers-reduced-motion. `mood` ajusta a leitura: celebrando
 * pulsa o acento, dormindo apaga o visor.
 */

export type OperatorMood = 'idle' | 'celebrating' | 'evolving' | 'sleeping';

interface OperatorSpriteProps {
  size: number;
  tier: GamificationTier;
  branch: OperatorBranch;
  skin: string | null;
  mood: OperatorMood;
}

const GRID_SIZE = 16;
const FRAME_MS = 600;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function OperatorSprite({
  size,
  tier,
  branch,
  skin,
  mood,
}: OperatorSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState(0);
  const animated = mood !== 'sleeping' && !prefersReducedMotion();

  useEffect(() => {
    if (!animated) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => setFrame((f) => (f + 1) % 2), FRAME_MS);
    return () => clearInterval(id);
  }, [animated]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.max(1, Math.floor(size / GRID_SIZE));
    const px = GRID_SIZE * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const palette = [...paletteFor(tier, branch, skin)];
    if (mood === 'sleeping') palette[3] = palette[2]; // visor apagado
    if ((mood === 'celebrating' || mood === 'evolving') && frame === 1) {
      palette[4] = palette[5] === 'rgba(0,0,0,0)' ? palette[3] : palette[5];
    }

    ctx.clearRect(0, 0, px, px);
    ctx.globalAlpha = mood === 'sleeping' ? 0.55 : 1;
    const bob = frame === 1 ? scale : 0; // 1px de respiração no frame B
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const idx = OPERATOR_GRID[y][x];
        if (idx === 0) continue;
        if (idx === 5 && frame === 1 && mood === 'idle') continue; // faísca
        ctx.fillStyle = palette[idx];
        ctx.fillRect(x * scale, y * scale + (idx === 5 ? 0 : bob), scale, scale);
      }
    }
  }, [size, tier, branch, skin, mood, frame]);

  return (
    <canvas
      ref={canvasRef}
      className="operator-sprite"
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      aria-hidden="true"
    />
  );
}
