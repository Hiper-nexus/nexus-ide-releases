/** Test-only transport: never exposed on window.nexus or sent in normal use. */
export const BUSY_BANNER_SMOKE_CHANNELS = {
  run: 'smoke:busy-banner:run', ready: 'smoke:busy-banner:ready', result: 'smoke:busy-banner:result',
} as const;
export const BUSY_BANNER_SMOKE_ENV = 'NEXUS_SMOKE_BUSY_BANNER_PROBE';
export const BUSY_BANNER_SMOKE_FILE = 'busy-banner-smoke.json';
export const BUSY_BANNER_SMOKE_TITLE = 'Nexus ocupado — capturando diagnóstico';
export const BUSY_BANNER_SMOKE_TIMEOUT_MS = 65_000;

export interface BusyBannerSmokeReady { nonce: string; armedAt: number }
export interface BusyBannerSmokeResult extends BusyBannerSmokeReady {
  shownAt: number;
  visibleAt: number;
  clearedAt: number;
  title: string;
  rect: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };
}
const NONCE_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function isBusyBannerSmokeNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_RE.test(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function parseBusyBannerSmokeReady(value: unknown): BusyBannerSmokeReady | null {
  if (!exact(value, ['nonce', 'armedAt']) || !isBusyBannerSmokeNonce(value.nonce) || !timestamp(value.armedAt)) return null;
  return { nonce: value.nonce, armedAt: value.armedAt };
}
export function parseBusyBannerSmokeResult(value: unknown): BusyBannerSmokeResult | null {
  if (!exact(value, ['nonce', 'armedAt', 'shownAt', 'visibleAt', 'clearedAt', 'title', 'rect']) ||
      !isBusyBannerSmokeNonce(value.nonce) || !timestamp(value.armedAt) || !timestamp(value.shownAt) ||
      !timestamp(value.visibleAt) || !timestamp(value.clearedAt) || value.shownAt <= value.armedAt ||
      value.visibleAt <= value.shownAt || value.clearedAt <= value.visibleAt ||
      value.title !== BUSY_BANNER_SMOKE_TITLE ||
      !exact(value.rect, ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'])) return null;
  const r = value.rect;
  if (!Object.values(r).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 32_768) ||
      !(Number(r.width) > 0 && Number(r.height) > 0 && Number(r.viewportWidth) > 0 && Number(r.viewportHeight) > 0) ||
      Number(r.x) + Number(r.width) > Number(r.viewportWidth) ||
      Number(r.y) + Number(r.height) > Number(r.viewportHeight)) return null;
  return {
    nonce: value.nonce, armedAt: value.armedAt, shownAt: value.shownAt, visibleAt: value.visibleAt,
    clearedAt: value.clearedAt, title: value.title,
    rect: { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height),
      viewportWidth: Number(r.viewportWidth), viewportHeight: Number(r.viewportHeight) },
  };
}
