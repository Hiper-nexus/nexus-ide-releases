const JARVIS_WAKE_EVENT = 'nexus:jarvis-wake-request';

export function requestJarvisWake(): void {
  window.dispatchEvent(new CustomEvent(JARVIS_WAKE_EVENT));
}

export function onJarvisWakeRequest(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(JARVIS_WAKE_EVENT, handler);
  return () => window.removeEventListener(JARVIS_WAKE_EVENT, handler);
}
