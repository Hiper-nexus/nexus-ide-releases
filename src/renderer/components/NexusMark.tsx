interface NexusMarkProps {
  size?: number;
  className?: string;
}

/**
 * Logomarca do NexusIDE — um "nó" pixel: diamante em anel com núcleo aceso.
 * Substitui o placeholder ◈ (glifo Unicode) por arte pixel de verdade, na
 * mesma pegada do Operator sprite. currentColor herda o acento de quem o usa.
 */

// Anel do diamante (borda) — pares esquerda/direita por linha + ápices.
const RING: Array<[number, number]> = [
  [5, 0],
  [4, 1], [6, 1],
  [3, 2], [7, 2],
  [2, 3], [8, 3],
  [1, 4], [9, 4],
  [0, 5], [10, 5],
  [1, 6], [9, 6],
  [2, 7], [8, 7],
  [3, 8], [7, 8],
  [4, 9], [6, 9],
  [5, 10],
];

export function NexusMark({ size = 16, className }: NexusMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 11 11"
      shapeRendering="crispEdges"
      fill="currentColor"
      role="img"
      aria-label="NexusIDE"
    >
      {RING.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
      ))}
      {/* Núcleo aceso — o "nó" no centro do diamante. */}
      <rect x="5" y="5" width="1" height="1" />
    </svg>
  );
}
