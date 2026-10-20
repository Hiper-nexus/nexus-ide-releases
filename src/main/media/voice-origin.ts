/**
 * Was this ElevenLabs voice cloned through "Minha voz" on this computer?
 * The consent store (voice-consents.ts) registers the lookup when it boots;
 * until then — and in tests — no voice counts as a Nexus clone, which only
 * makes the origin read "external-clone": never a false consent claim.
 */

let lookup: (voiceId: string) => boolean = () => false;

export function setNexusClonedVoiceLookup(next: (voiceId: string) => boolean): void {
  lookup = next;
}

export function isNexusClonedVoice(voiceId: string): boolean {
  try {
    return lookup(voiceId);
  } catch {
    return false;
  }
}
