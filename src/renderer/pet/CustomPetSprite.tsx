import { useEffect, useRef } from 'react';
import type { PetCustomGrid } from '../../shared/pet-types';

/**
 * Sprite do pet personalizado: desenha a grade 16×16 pixelizada da imagem do
 * usuário em escala inteira (pixel art nítida), como o OperatorSprite. A
 * animação (bob/celebração/sono) fica no wrapper CSS — o canvas é estático.
 */

interface CustomPetSpriteProps {
  grid: PetCustomGrid;
  size: number;
}

export function CustomPetSprite({ grid, size }: CustomPetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cells = grid.length;
  const scale = Math.max(1, Math.floor(size / cells));
  const pixelSize = scale * cells;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < cells; y += 1) {
      for (let x = 0; x < cells; x += 1) {
        const cell = grid[y][x];
        if (!cell) continue;
        ctx.fillStyle = cell;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }, [grid, cells, scale]);

  return (
    <canvas
      ref={canvasRef}
      width={pixelSize}
      height={pixelSize}
      style={{ width: pixelSize, height: pixelSize, imageRendering: 'pixelated' }}
      aria-hidden="true"
    />
  );
}
