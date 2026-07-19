/**
 * Vendored QR encoder — the battle-tested `node-qrcode` (soldair/node-qrcode,
 * MIT) core + SVG renderer + its only runtime dep `dijkstrajs` (MIT). Vendored
 * because the packaged build blocks external network and we do not add runtime
 * npm deps for this; the Nexus already vendors Orca-derived modules the same
 * way. Licenses: ./LICENSE-node-qrcode, ./LICENSE-dijkstrajs.
 *
 * We replaced our hand-rolled encoder (which didn't reliably decode) with this
 * — validated to round-trip through opencv's QR decoder for real LAN URLs.
 */

// O bundle ESM é gerado dos fontes CJS por scripts/vendor-qrcode-esm.mjs —
// o dev server do vite não tolera CJS cru em src/ ("require is not defined").
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error bundle ESM gerado, sem tipos
import { QRCodeCore, SvgRenderer } from './bundle.mjs';

interface QrData {
  modules: { size: number; data: Uint8Array };
}

interface QrCoreModule {
  create(data: string, options: { errorCorrectionLevel: string }): QrData;
}
interface SvgRendererModule {
  render(qr: QrData, options: Record<string, unknown>): string;
}

const core = QRCodeCore as unknown as QrCoreModule;
const svg = SvgRenderer as unknown as SvgRendererModule;

export interface QrSvgOptions {
  /** Quiet-zone modules around the code (default 4). */
  margin?: number;
  /** Rendered pixel size of the SVG (default: intrinsic module units). */
  width?: number;
}

/** Encode text into a self-contained SVG QR string (EC level M). */
export function encodeQrSvg(text: string, options: QrSvgOptions = {}): string {
  const qr = core.create(text, { errorCorrectionLevel: 'M' });
  return svg.render(qr, {
    margin: options.margin ?? 4,
    width: options.width,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

/** Encode text into a boolean module matrix (true = dark). For tests/custom UI. */
export function encodeQrMatrix(text: string): boolean[][] {
  const qr = core.create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = qr.modules;
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c += 1) row.push(Boolean(data[r * size + c]));
    rows.push(row);
  }
  return rows;
}
