const COMPANION_WEB_ORIGIN = 'https://app.nexuside.app';

/**
 * QR codes point at the Companion PWA instead of directly at wss://. The
 * room secret remains inside the fragment, so it is never sent to Cloudflare,
 * Railway or the relay during navigation.
 */
export function formatCompanionWebUrl(relayRoomLink: string): string {
  let url: URL;
  try {
    url = new URL(relayRoomLink);
  } catch {
    throw new Error('invalid relay room link');
  }
  if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || !url.hash) {
    throw new Error('invalid relay room link');
  }
  return `${COMPANION_WEB_ORIGIN}/#${encodeURIComponent(relayRoomLink)}`;
}
