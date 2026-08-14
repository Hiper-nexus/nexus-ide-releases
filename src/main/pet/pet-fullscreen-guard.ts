/**
 * Fullscreen nativo no macOS cria um Space. Se o pet (alwaysOnTop +
 * visibleOnFullScreen) re-pin no meio da animação, o WindowServer troca o
 * Space, o app sai de primeiro plano e a tela faz slide abre/fecha.
 */

export type AppFullscreenEvent = 'enter-full-screen' | 'leave-full-screen';

export type PetFullscreenAction = 'hide-and-silence' | 'silence-then-repin';

export function petActionForAppFullscreenEvent(
  event: AppFullscreenEvent,
): PetFullscreenAction {
  return event === 'enter-full-screen' ? 'hide-and-silence' : 'silence-then-repin';
}

export function shouldRaisePetAboveAll(input: {
  readonly platform: NodeJS.Platform;
  readonly inFullscreenTransition: boolean;
  readonly appIsFullScreen: boolean;
}): boolean {
  if (input.inFullscreenTransition) return false;
  if (input.platform === 'darwin' && input.appIsFullScreen) return false;
  return true;
}
