export type PixelIconName =
  | 'mission'
  | 'agent'
  | 'terminal'
  | 'browser'
  | 'grid'
  | 'canvas'
  | 'files'
  | 'board'
  | 'orch'
  | 'config'
  | 'mic'
  | 'plus'
  | 'sparkle'
  | 'close'
  | 'sun'
  | 'moon'
  | 'chevron'
  | 'status-idle'
  | 'status-busy'
  | 'status-exited'
  | 'status-hibernated'
  | 'status-spawning';

/**
 * Icon set pixel — desenhado no MESMO grid 11×11 do NexusMark, em rects crisp
 * (currentColor). Um idioma só de ícones, na pegada operador/pixel, no lugar da
 * sopa de emoji + glifos Unicode. Cada ícone é uma lista de rects [x,y,w,h]
 * (w/h default 1).
 */

type Rect = [number, number, number?, number?];

const ICONS: Record<PixelIconName, Rect[]> = {
  // ▸ play em degraus
  mission: [
    [3, 2, 1, 7],
    [4, 3, 1, 5],
    [5, 4, 1, 3],
    [6, 5, 1, 1],
  ],
  // cabeça de robô: antena + contorno + dois olhos
  agent: [
    [5, 1, 1, 2],
    [2, 3, 7, 1],
    [2, 3, 1, 5],
    [8, 3, 1, 5],
    [2, 8, 7, 1],
    [4, 5, 1, 1],
    [6, 5, 1, 1],
  ],
  // >_ prompt
  terminal: [
    [2, 3, 1, 1],
    [3, 4, 1, 1],
    [4, 5, 1, 1],
    [3, 6, 1, 1],
    [2, 7, 1, 1],
    [5, 8, 4, 1],
  ],
  // janela com barra de título
  browser: [
    [1, 2, 9, 1],
    [1, 2, 1, 6],
    [9, 2, 1, 6],
    [1, 8, 9, 1],
    [1, 4, 9, 1],
  ],
  // 2×2 blocos
  grid: [
    [1, 1, 3, 3],
    [7, 1, 3, 3],
    [1, 7, 3, 3],
    [7, 7, 3, 3],
  ],
  // moldura + nó solto (canvas livre)
  canvas: [
    [1, 1, 9, 1],
    [1, 1, 1, 9],
    [9, 1, 1, 9],
    [1, 9, 9, 1],
    [4, 4, 3, 3],
  ],
  // pasta (aba + corpo)
  files: [
    [1, 3, 4, 1],
    [1, 4, 9, 1],
    [1, 4, 1, 5],
    [9, 4, 1, 5],
    [1, 8, 9, 1],
  ],
  // kanban: header + 3 colunas
  board: [
    [1, 2, 9, 1],
    [1, 4, 2, 6],
    [5, 4, 2, 6],
    [8, 4, 2, 6],
  ],
  // hub + 4 spokes
  orch: [
    [4, 4, 3, 3],
    [5, 1, 1, 2],
    [5, 8, 1, 2],
    [1, 5, 2, 1],
    [8, 5, 2, 1],
  ],
  // sliders (configuração)
  config: [
    [1, 3, 9, 1],
    [3, 2, 2, 3],
    [1, 7, 9, 1],
    [6, 6, 2, 3],
  ],
  // microfone
  mic: [
    [4, 1, 3, 5],
    [3, 5, 1, 1],
    [7, 5, 1, 1],
    [5, 6, 1, 2],
    [3, 9, 5, 1],
  ],
  // + cruz
  plus: [
    [5, 2, 1, 7],
    [2, 5, 7, 1],
  ],
  // faísca (magia / squad sob medida)
  sparkle: [
    [5, 2, 1, 7],
    [2, 5, 7, 1],
    [3, 3, 1, 1],
    [7, 7, 1, 1],
    [7, 3, 1, 1],
    [3, 7, 1, 1],
  ],
  // close / cross (x)
  close: [
    [3, 3, 1, 1],
    [4, 4, 1, 1],
    [5, 5, 1, 1],
    [6, 6, 1, 1],
    [7, 7, 1, 1],
    [7, 3, 1, 1],
    [6, 4, 1, 1],
    [4, 6, 1, 1],
    [3, 7, 1, 1],
  ],
  // sun (wake)
  sun: [
    [4, 4, 3, 3],
    [5, 1, 1, 2],
    [5, 8, 1, 2],
    [1, 5, 2, 1],
    [8, 5, 2, 1],
  ],
  // moon (sleep)
  moon: [
    [4, 2, 4, 1],
    [3, 3, 2, 1],
    [2, 4, 2, 1],
    [2, 5, 2, 1],
    [2, 6, 2, 1],
    [3, 7, 2, 1],
    [4, 8, 4, 1],
  ],
  // chevron right
  chevron: [
    [4, 3],
    [5, 4],
    [6, 5],
    [5, 6],
    [4, 7],
  ],
  // status idle (filled circle)
  'status-idle': [
    [4, 3, 3, 1],
    [3, 4, 5, 1],
    [3, 5, 5, 1],
    [3, 6, 5, 1],
    [4, 7, 3, 1],
  ],
  // status busy (dashed/dotted-like ring)
  'status-busy': [
    [5, 3, 1, 1],
    [3, 5, 1, 1],
    [7, 5, 1, 1],
    [5, 7, 1, 1],
    [4, 4, 1, 1], [6, 4, 1, 1],
    [4, 6, 1, 1], [6, 6, 1, 1],
  ],
  // status exited (small cross)
  'status-exited': [
    [3, 3, 1, 1], [7, 3, 1, 1],
    [4, 4, 1, 1], [6, 4, 1, 1],
    [5, 5, 1, 1],
    [4, 6, 1, 1], [6, 6, 1, 1],
    [3, 7, 1, 1], [7, 7, 1, 1],
  ],
  // status hibernated (circle with horizontal bar)
  'status-hibernated': [
    [4, 3, 3, 1],
    [3, 4, 1, 1], [7, 4, 1, 1],
    [3, 5, 5, 1],
    [3, 6, 1, 1], [7, 6, 1, 1],
    [4, 7, 3, 1],
  ],
  // status spawning (hollow circle)
  'status-spawning': [
    [4, 3, 3, 1],
    [3, 4, 1, 1], [7, 4, 1, 1],
    [3, 5, 1, 1], [7, 5, 1, 1],
    [3, 6, 1, 1], [7, 6, 1, 1],
    [4, 7, 3, 1],
  ],
};

interface PixelIconProps {
  name: PixelIconName;
  size?: number;
  className?: string;
}

export function PixelIcon({ name, size = 12, className }: PixelIconProps) {
  return (
    <svg
      className={`pixel-icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 11 11"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
    >
      {ICONS[name].map(([x, y, w = 1, h = 1], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} />
      ))}
    </svg>
  );
}
