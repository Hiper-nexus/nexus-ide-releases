import { useMemo } from 'react';
import { encodeQrMatrix } from '../../vendor/qrcode';

type Props = {
  /** Text to encode (e.g. the LAN pairing URL). */
  value: string;
  /** Rendered pixel size of the square (default 180). */
  size?: number;
  /** Quiet-zone modules around the code (default 4). */
  quiet?: number;
  label?: string;
};

/**
 * Renders a QR as native SVG <rect> elements from the vendored node-qrcode
 * matrix — no dangerouslySetInnerHTML, so there is no HTML-injection surface
 * (the value becomes QR modules, never markup). Self-contained; no network.
 */
export function QrCode({ value, size = 180, quiet = 4, label = 'QR code' }: Props) {
  const modules = useMemo(() => encodeQrMatrix(value), [value]);
  const count = modules.length;
  const dim = count + quiet * 2;

  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      {modules.flatMap((row, r) =>
        row.map((dark, c) =>
          dark ? (
            <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width="1" height="1" fill="#000000" />
          ) : null,
        ),
      )}
    </svg>
  );
}
