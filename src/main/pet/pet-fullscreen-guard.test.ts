import { describe, expect, it } from 'vitest';
import {
  petActionForAppFullscreenEvent,
  petWorkspacePinForFullscreenEvent,
  shouldKeepPetFullscreenSilence,
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

  it('unpins alwaysOnTop and all-workspaces on enter, before hide', () => {
    expect(petWorkspacePinForFullscreenEvent('enter-full-screen')).toEqual({
      alwaysOnTop: false,
      visibleOnAllWorkspaces: false,
      visibleOnFullScreen: false,
    });
  });

  it('restores desktop pin on leave without following fullscreen Spaces', () => {
    expect(petWorkspacePinForFullscreenEvent('leave-full-screen')).toEqual({
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      visibleOnFullScreen: false,
    });
  });

  it('keeps silence while darwin fullscreen or latched, not only a short timer', () => {
    expect(
      shouldKeepPetFullscreenSilence({
        platform: 'darwin',
        appIsFullScreen: true,
        silenceLatched: false,
      }),
    ).toBe(true);
    expect(
      shouldKeepPetFullscreenSilence({
        platform: 'darwin',
        appIsFullScreen: false,
        silenceLatched: true,
      }),
    ).toBe(true);
    expect(
      shouldKeepPetFullscreenSilence({
        platform: 'darwin',
        appIsFullScreen: false,
        silenceLatched: false,
      }),
    ).toBe(false);
    expect(
      shouldKeepPetFullscreenSilence({
        platform: 'linux',
        appIsFullScreen: true,
        silenceLatched: false,
      }),
    ).toBe(false);
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
