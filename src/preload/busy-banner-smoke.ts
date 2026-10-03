import {
  BUSY_BANNER_SMOKE_TIMEOUT_MS, BUSY_BANNER_SMOKE_TITLE, isBusyBannerSmokeNonce,
  type BusyBannerSmokeReady, type BusyBannerSmokeResult,
} from '../shared/busy-banner-smoke';

/** Observes the production banner, never changes its DOM or heartbeat timing. */
export function observeBusyBannerForSmoke(
  nonce: string, ready: (value: BusyBannerSmokeReady) => void,
): Promise<BusyBannerSmokeResult> {
  if (!isBusyBannerSmokeNonce(nonce)) return Promise.reject(new Error('invalid busy banner smoke nonce'));
  return new Promise((resolve, reject) => {
    let frame = 0;
    let armedAt = 0;
    let idleFrames = 0;
    let shownAt = 0;
    let visibleAt = 0;
    let rect: BusyBannerSmokeResult['rect'] | null = null;
    const timer = setTimeout(() => finish(new Error('busy banner observer timed out')), BUSY_BANNER_SMOKE_TIMEOUT_MS);
    const finish = (error?: Error, value?: BusyBannerSmokeResult): void => {
      clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const check = (): void => {
      const root = document.querySelector('.main-busy[role="status"][aria-live="polite"]');
      if (!root?.isConnected) { finish(new Error('busy banner live region missing')); return; }
      const band = root.querySelector<HTMLElement>('.main-busy__band');
      const at = Date.now();
      if (document.visibilityState !== 'visible') {
        // Hiding the window during the episode invalidates continuous visible evidence.
        if (armedAt) { finish(new Error('busy banner smoke window became hidden')); return; }
        idleFrames = 0;
      } else if (!armedAt) {
        if (band) idleFrames = 0;
        else if (++idleFrames >= 2) { armedAt = at; ready({ nonce, armedAt }); }
      } else if (!band && visibleAt && rect) {
        finish(undefined, { nonce, armedAt, shownAt, visibleAt, clearedAt: at, title: BUSY_BANNER_SMOKE_TITLE, rect });
        return;
      } else if (band) {
        const bounds = band.getBoundingClientRect();
        const titleElement = band.querySelector('.main-busy__title');
        const title = titleElement?.textContent?.trim();
        let visible = band.isConnected && title === BUSY_BANNER_SMOKE_TITLE &&
          bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0 &&
          bounds.x + bounds.width <= window.innerWidth && bounds.y + bounds.height <= window.innerHeight;
        for (let element: Element | null = titleElement; visible && element; element = element.parentElement) {
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
              (style.opacity !== '' && Number(style.opacity) < 0.95)) visible = false;
        }
        if (visible) {
          if (!shownAt) shownAt = at;
          else if (!visibleAt && at > shownAt) {
            visibleAt = at;
            rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
              viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
          }
        } else if (!visibleAt) shownAt = 0;
      }
      frame = window.requestAnimationFrame(check);
    };
    frame = window.requestAnimationFrame(check);
  });
}
