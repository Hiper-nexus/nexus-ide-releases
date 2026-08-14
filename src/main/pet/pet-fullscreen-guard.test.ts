import { describe, expect, it } from 'vitest';
import {
  petActionForAppFullscreenEvent,
  shouldRaisePetAboveAll,
} from './pet-fullscreen-guard';

describe('pet fullscreen guard', () => {
  it('hides the pet on enter so it cannot steal the fullscreen Space', () => {
    expect(petActionForAppFullscreenEvent('enter-full-screen')).toBe(
      'hide-and-silence',
    );
  });

  it('only re-pins after leave, when the Space animation is done', () => {
    expect(petActionForAppFullscreenEvent('leave-full-screen')).toBe(
      'silence-then-repin',
    );
  });

  it('never raises the pet during the transition or while the app is fullscreen on macOS', () => {
    expect(
      shouldRaisePetAboveAll({
        platform: 'darwin',
        inFullscreenTransition: true,
        appIsFullScreen: false,
      }),
    ).toBe(false);
    expect(
      shouldRaisePetAboveAll({
        platform: 'darwin',
        inFullscreenTransition: false,
        appIsFullScreen: true,
      }),
    ).toBe(false);
    expect(
      shouldRaisePetAboveAll({
        platform: 'darwin',
        inFullscreenTransition: false,
        appIsFullScreen: false,
      }),
    ).toBe(true);
  });

  it('still raises on other platforms when the app is fullscreen', () => {
    expect(
      shouldRaisePetAboveAll({
        platform: 'linux',
        inFullscreenTransition: false,
        appIsFullScreen: true,
      }),
    ).toBe(true);
  });
});
