import pcmWorkletSource from './pcm-processor.js?raw';

/**
 * Shared blob: URL for the PCM AudioWorklet used by wake-mic and capture.
 *
 * Vite can inline a small `?url` import as a data: URL. Production CSP allows
 * blob: but not data:, which silently forced both capture paths to the slow
 * ScriptProcessor fallback in packaged builds.
 */
export const PCM_WORKLET_NODE_NAME = 'nexus-pcm-processor';

let cachedUrl: string | null = null;

/** Create the sanctioned CSP-compatible module URL once per renderer session. */
export function pcmWorkletBlobUrl(): string {
  if (!cachedUrl) {
    cachedUrl = URL.createObjectURL(
      new Blob([pcmWorkletSource], { type: 'text/javascript' }),
    );
  }
  return cachedUrl;
}
