// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeBusyBannerForSmoke } from './busy-banner-smoke';

const nonce = '11111111-1111-4111-8111-111111111111';
let frame: FrameRequestCallback | undefined;
let at = 100;
const ready: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Date, 'now').mockImplementation(() => at);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frame = cb; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frame = undefined; });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.body.innerHTML = '<div class="main-busy" role="status" aria-live="polite"></div>';
  at = 100; ready.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; });

function paint(time: number) { at = time; const cb = frame; frame = undefined; cb?.(time); }
function show(options: { hidden?: boolean; outside?: boolean } = {}) {
  const root = document.querySelector('.main-busy')!;
  root.innerHTML = '<div class="main-busy__band"><span class="main-busy__title">Nexus ocupado — capturando diagnóstico</span></div>';
  const band = root.firstElementChild as HTMLElement;
  band.style.opacity = options.hidden ? '0' : '1';
  band.getBoundingClientRect = () => ({ x: options.outside ? 2000 : 30, y: 8, width: 480, height: 28, top: 8, left: 30, right: 510, bottom: 36, toJSON: () => ({}) });
}

describe('preload observes the real busy banner DOM', () => {
  it('arms while idle and records two visible frames and automatic removal', async () => {
    const pending = observeBusyBannerForSmoke(nonce, report => ready.push(report));
    paint(116); paint(132);
    expect(ready).toEqual([{ nonce, armedAt: 132 }]);
    show(); paint(11_100); paint(11_116);
    document.querySelector('.main-busy')!.innerHTML = '';
    paint(40_200);
    expect(await pending).toMatchObject({ nonce, armedAt: 132, shownAt: 11_100, visibleAt: 11_116, clearedAt: 40_200, rect: { width: 480, height: 28 } });
    expect(frame).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ hidden: true }, { outside: true }])('never accepts a banner that is not visible in the viewport %j', async options => {
    const pending = observeBusyBannerForSmoke(nonce, report => ready.push(report));
    const failure = expect(pending).rejects.toThrow(/timed out/);
    paint(116); paint(132); show(options); paint(11_100); paint(11_116);
    document.querySelector('.main-busy')!.innerHTML = ''; paint(40_200);
    await vi.advanceTimersByTimeAsync(65_000);
    await failure;
    expect(frame).toBeUndefined();
  });

  it('does not authorize a hang from a hidden renderer', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const pending = observeBusyBannerForSmoke(nonce, report => ready.push(report));
    const failure = expect(pending).rejects.toThrow(/timed out/);
    paint(116); paint(132);
    expect(ready).toEqual([]);
    await vi.advanceTimersByTimeAsync(65_000); await failure;
  });
});
