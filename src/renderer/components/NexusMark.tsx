interface NexusMarkProps {
  size?: number;
  className?: string;
}

/**
 * Logomarca do NexusIDE: o "N" pixel do site e do ícone do app (assets/icon.png,
 * gerado por scripts/build-app-icon-source.mjs). Grade 4×4: as duas pontas
 * cheias e a diagonal no meio. Tudo em currentColor para herdar o acento de
 * quem o usa (o rosa da marca, no boot e na tela de acesso).
 */

// Células [coluna, linha] do N. Mesmo desenho de nexus-site/public/favicon.svg.
export const NEXUS_N_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0, 1], [0, 2], [0, 3],
  [3, 0], [3, 1], [3, 2], [3, 3],
  [1, 1], [2, 2],
];

export function NexusMark({ size = 16, className }: NexusMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 4 4"
      shapeRendering="crispEdges"
      fill="currentColor"
      role="img"
      aria-label="NexusIDE"
    >
      {NEXUS_N_CELLS.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
      ))}
    </svg>
  );
}
