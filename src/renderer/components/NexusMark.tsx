interface NexusMarkProps {
  size?: number;
  className?: string;
}

/**
 * Logomarca do NexusIDE — o "nó-nexus" pixel: anel diamante com núcleo aceso
 * e quatro satélites orbitais (a frota convergindo ao nó). Grade 13×13, na
 * mesma pegada do PixelIcon/Operator sprite; profundidade por opacidade, tudo
 * em currentColor para herdar o acento de quem o usa. Mesmo desenho do ícone
 * do app (assets/icon.png).
 */

// Anel do diamante |dx|+|dy| = 4 em volta do centro (6,6).
const RING: Array<[number, number]> = [
  [6, 2],
  [7, 3], [8, 4], [9, 5],
  [10, 6],
  [9, 7], [8, 8], [7, 9],
  [6, 10],
  [5, 9], [4, 8], [3, 7],
  [2, 6],
  [3, 5], [4, 4], [5, 3],
];

// Núcleo aceso: plus central — o "nó" vivo.
const CORE: Array<[number, number]> = [
  [6, 6],
  [5, 6], [7, 6],
  [6, 5], [6, 7],
];

// Satélites orbitais nos eixos cardeais — a frota.
const ORBITALS: Array<[number, number]> = [
  [6, 0],
  [12, 6],
  [6, 12],
  [0, 6],
];

export function NexusMark({ size = 16, className }: NexusMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 13 13"
      shapeRendering="crispEdges"
      fill="currentColor"
      role="img"
      aria-label="NexusIDE"
    >
      {RING.map(([x, y]) => (
        <rect key={`r${x}-${y}`} x={x} y={y} width="1" height="1" opacity="0.92" />
      ))}
      {ORBITALS.map(([x, y]) => (
        <rect key={`o${x}-${y}`} x={x} y={y} width="1" height="1" opacity="0.55" />
      ))}
      {CORE.map(([x, y]) => (
        <rect key={`c${x}-${y}`} x={x} y={y} width="1" height="1" />
      ))}
    </svg>
  );
}
