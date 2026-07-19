/**
 * Entry para o bundle ESM gerado por scripts/vendor-qrcode-esm.mjs.
 * O esbuild converte os módulos CJS vendored (node-qrcode, dijkstrajs)
 * para ESM — inclusive as referências internas a exports.* — e o
 * resultado serve dev (vite) e produção (rollup) igual.
 */
import * as QRCodeCore from './core/qrcode.js';
import * as SvgRenderer from './renderer/svg-tag.js';

export { QRCodeCore, SvgRenderer };
