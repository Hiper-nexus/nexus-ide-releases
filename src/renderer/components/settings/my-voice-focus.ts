/**
 * F-1616: the studio's "Criar minha voz" shortcut opens Serviços de mídia and
 * asks the Minha voz card to scroll into view and take focus once it renders.
 * Kept apart from MyVoiceCard so the studio does not load the whole card.
 */
let focusRequested = false;

export function requestMyVoiceFocus(): void {
  focusRequested = true;
}

/** True once per request; the card calls it when it is on screen. */
export function consumeMyVoiceFocus(): boolean {
  if (!focusRequested) return false;
  focusRequested = false;
  return true;
}
