/**
 * Fullscreen nativo no macOS cria um Space. Hide() sozinho não basta:
 * visibleOnAllWorkspaces + alwaysOnTop no pet (mesmo escondido) ainda
 * entram na coleção de Spaces e sequestram o desktop depois do enter.
 * O pet some no fullscreen de propósito — nunca visibleOnFullScreen.
 */

export type AppFullscreenEvent = 'enter-full-screen' | 'leave-full-screen';

export type PetFullscreenAction = 'hide-and-silence' | 'silence-then-repin';

export type PetWorkspacePin = {
  readonly alwaysOnTop: boolean;
  readonly visibleOnAllWorkspaces: boolean;
  readonly visibleOnFullScreen: boolean;
};

export function petActionForAppFullscreenEvent(
  event: AppFullscreenEvent,
): PetFullscreenAction {
  return event === 'enter-full-screen' ? 'hide-and-silence' : 'silence-then-repin';
}

/** Enter: desliga o pin (depois hide). Leave: restaura desktop, sem seguir FS. */
export function petWorkspacePinForFullscreenEvent(
  event: AppFullscreenEvent,
): PetWorkspacePin {
  if (event === 'enter-full-screen') {
    return {
      alwaysOnTop: false,
      visibleOnAllWorkspaces: false,
      visibleOnFullScreen: false,
    };
  }
  return {
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    visibleOnFullScreen: false,
  };
}

export function shouldKeepPetFullscreenSilence(input: {
  readonly platform: NodeJS.Platform;
  readonly appIsFullScreen: boolean;
  readonly silenceLatched: boolean;
}): boolean {
  if (input.silenceLatched) return true;
  return input.platform === 'darwin' && input.appIsFullScreen;
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
