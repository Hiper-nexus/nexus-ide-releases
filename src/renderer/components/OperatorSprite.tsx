import { useEffect, useRef, useState } from 'react';
import type {
  GamificationTier,
  OperatorBranch,
} from '../../shared/gamification-types';
import { OPERATOR_GRID, paletteFor } from './operator-sprite-data';
import {
  operatorFrameMs,
  shouldAnimateOperatorMood,
  type OperatorMood,
} from './operator-motion';

/**
 * Mascote pixel programático: desenha OPERATOR_GRID num canvas em escala
 * INTEIRA (pixel art nítida). 4 frames de idle com respiração e faísca de
 * aura, desligados com prefers-reduced-motion. `mood` ajusta a leitura:
 * celebrando pulsa o acento, dormindo apaga o visor.
 */

export type { OperatorMood } from './operator-motion';

interface OperatorSpriteProps {
  size: number;
  tier: GamificationTier;
  branch: OperatorBranch;
  skin: string | null;
  mood: OperatorMood;
}

const GRID_SIZE = 16;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
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
  const reducedMotion = usePrefersReducedMotion();
  const [documentVisible, setDocumentVisible] = useState(() =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisibilityChange = () =>
      setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);
  const animated = shouldAnimateOperatorMood(
    mood,
    reducedMotion,
    documentVisible,
  );

  useEffect(() => {
    if (!animated) {
      setFrame(0);
      return;
    }
    const id = setInterval(
      () => setFrame((f) => (f + 1) % 4),
      operatorFrameMs(mood),
    );
    return () => clearInterval(id);
  }, [animated, mood]);

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
    if ((mood === 'celebrating' || mood === 'evolving') && frame % 2 === 1) {
      palette[4] = palette[5] === 'rgba(0,0,0,0)' ? palette[3] : palette[5];
    }

    ctx.clearRect(0, 0, px, px);
    ctx.globalAlpha = mood === 'sleeping' ? 0.55 : 1;
    const bodyBob = frame === 1 || frame === 2 ? -scale : 0;
    const accentNudge = frame === 2 ? scale : 0;
    const auraOn = mood !== 'idle' || frame !== 2;
    for (let y = 0; y < GRID_SIZE; y += 1) {
      for (let x = 0; x < GRID_SIZE; x += 1) {
        const idx = OPERATOR_GRID[y][x];
        if (idx === 0) continue;
        if (idx === 5 && !auraOn) continue;
        ctx.fillStyle = palette[idx];
        ctx.fillRect(
          x * scale + (idx === 4 ? accentNudge : 0),
          y * scale + (idx === 5 ? 0 : bodyBob),
          scale,
          scale,
        );
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
