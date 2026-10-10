import { RUNTIME_DOM_REQUEST, RUNTIME_DOM_REPLY, RUNTIME_URL_MARKER } from '../shared/runtime-gates';
import { soakNonce } from '../shared/soak-smoke';
export function isRuntimeRendererUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'nexus-app:' && url.pathname === '/index.html' && url.searchParams.get(RUNTIME_URL_MARKER) === '1'; } catch { return false; }
}
const eligible = typeof location !== 'undefined' && isRuntimeRendererUrl(location.href);
export function installRuntimeGateRenderer(): void {
  if (!eligible) return;
  let nonce: string | null = null, tail = Promise.resolve();
  let restoreMedia: (() => void) | null = null;
  const streams = new Set<MediaStream>(), contexts = new Set<AudioContext>();
  const contextIds = new WeakMap<AudioContext, string>();
  const shells = new Set<string>();
  const movedShells = new Set<string>();
  let frames = 0;
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const mediaSnapshot = () => ({ tracks: [...new Map([...streams].flatMap(s => s.getTracks()).map(t => [t.id, t])).values()].map(t => ({ id: t.id, kind: t.kind, state: t.readyState })),
    contexts: [...contexts].map(c => ({ id: contextIds.get(c), state: c.state })), frames });
  window.addEventListener(RUNTIME_DOM_REQUEST, event => {
    const detail = (event as CustomEvent).detail;
    // Snapshot the private message before waiting for renderer module loads.
    const value = detail && typeof detail === 'object' ? { ...detail } : null;
    if (!value || typeof value !== 'object' || !soakNonce.safeParse(value.nonce).success || nonce && nonce !== value.nonce ||
      !Number.isSafeInteger(value.request) || value.request < 0 || value.request > 150) return;
    nonce ??= value.nonce;
    const reply = (ok: boolean, result?: unknown): void => { window.dispatchEvent(new CustomEvent(RUNTIME_DOM_REPLY, { detail: { nonce, request: value.request, ok, result } })); };
    tail = tail.then(async () => {
      const [{ useLayoutStore }, terminal, { listPanes }, { useProductNavigationStore }] = await Promise.all([
        import('./state/layout-store'), import('./terminal/terminal-host'), import('./lib/split-tree'), import('./state/product-navigation-store')]);
      if (value.operation === 'operator-pane') {
        if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 128)) throw new Error('normal native model invalid');
        useProductNavigationStore.getState().openTerminal(); await frame();
        const paneId = useLayoutStore.getState().spawnAgent('claude', value.model ?? '');
        if (!paneId) throw new Error('normal operator pane refused');
        const sessionId = await terminal.waitForSession(paneId, 10000);
        if (!sessionId) throw new Error('normal operator native session absent');
        reply(true, { paneId, sessionId }); return;
      }
      if (value.operation === 'user-prompt' || value.operation === 'mission-prompt') {
        const pane = listPanes(useLayoutStore.getState().root).find(p => p.id === value.paneId);
        if (pane?.kind !== 'cli-agent' || pane.adapterId !== 'claude' || terminal.getPaneSessionId(pane.id) !== value.sessionId ||
          typeof value.text !== 'string' || !value.text.startsWith('RT_GATE ') || value.text.length > 1024) throw new Error('private normal prompt target differs');
        const accepted = value.operation === 'user-prompt' ? await terminal.submitPromptToPaneConfirmed(pane.id, value.text, value.sessionId) :
          await terminal.submitPromptToPaneOperatorInput(pane.id, value.text, value.sessionId);
        if (!accepted || terminal.getPaneSessionId(pane.id) !== value.sessionId) throw new Error('private normal prompt refused');
        reply(true, { paneId: pane.id, sessionId: value.sessionId }); return;
      }
      if (value.operation === 'shell') {
        useProductNavigationStore.getState().openTerminal(); await frame();
        const paneId = useLayoutStore.getState().addShellPane(), sessionId = await terminal.waitForSession(paneId, 10000);
        if (!sessionId) throw new Error('runtime shell absent'); shells.add(paneId); reply(true, { paneId, sessionId }); return;
      }
      if (value.operation === 'move') {
        const panes = listPanes(useLayoutStore.getState().root), pane = panes.find(p => p.id === value.paneId);
        if (!pane || pane.kind !== 'shell' || !shells.has(pane.id)) throw new Error('runtime move requires its loose shell');
        if (panes.filter(p => shells.has(p.id)).length !== 2) throw new Error('runtime move requires two privately minted shells');
        const element = terminal.getOrCreateHost(pane).term.element, before = element?.getBoundingClientRect();
        if (!element?.isConnected || !before || before.width <= 0 || before.height <= 0) throw new Error('runtime pane not mounted before move');
        useLayoutStore.getState().setPanes([...panes].reverse());
        await frame(); await frame(); const after = element.getBoundingClientRect();
        if (!element.isConnected || after.width <= 0 || after.height <= 0 || after.left === before.left && after.top === before.top) throw new Error('runtime pane did not visibly move');
        movedShells.add(pane.id); reply(true, { sessionId: terminal.getPaneSessionId(pane.id), moved: true }); return;
      }
      if (value.operation === 'move-view') {
        const pane = listPanes(useLayoutStore.getState().root).find(p => p.id === value.paneId);
        if (!pane || !movedShells.has(pane.id) || typeof value.marker !== 'string' || value.marker.length > 128) throw new Error('runtime move view absent');
        await frame(); await frame(); const term = terminal.getOrCreateHost(pane).term, element = term.element, rect = element?.getBoundingClientRect();
        if (!element?.isConnected || !rect || rect.width <= 0 || rect.height <= 0 || getComputedStyle(element).visibility !== 'visible' ||
            rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth || document.visibilityState !== 'visible') throw new Error('moved terminal is not visible');
        const buffer = term.buffer.active; let echoVisible = false;
        for (let line = Math.max(0, buffer.length - 64); line < buffer.length; line++) if (buffer.getLine(line)?.translateToString().includes(value.marker)) echoVisible = true;
        reply(true, { echoVisible, moved: true, frames: 2 }); return;
      }
      if (value.operation === 'close') {
        const pane = listPanes(useLayoutStore.getState().root).find(p => p.id === value.paneId);
        if (!pane || pane.kind !== 'shell' || !shells.has(pane.id)) throw new Error('runtime close requires its loose shell');
        useLayoutStore.getState().close(pane.id, 'private-runtime-acceptance'); shells.delete(pane.id); await frame(); reply(true); return;
      }
      if (value.operation === 'question') {
        if (typeof value.missionId !== 'string' || typeof value.marker !== 'string' || value.marker.length > 256) throw new Error('runtime question invalid');
        useProductNavigationStore.getState().openMission(value.missionId); await frame(); await frame();
        const visible = [...document.querySelectorAll<HTMLElement>('h1,h2,h3,p,button,span')].some(e => {
          const r = e.getBoundingClientRect(), style = getComputedStyle(e); return e.textContent?.includes(value.marker) && e.isConnected && r.width > 0 && r.height > 0 &&
            style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0;
        });
        reply(true, { visible }); return;
      }
      if (value.operation === 'media-observe') {
        if (restoreMedia) throw new Error('overlapping runtime media observer');
        const originalMedia = navigator.mediaDevices.getUserMedia, OriginalContext = window.AudioContext, OriginalWorklet = window.AudioWorkletNode;
        navigator.mediaDevices.getUserMedia = async function(constraints) { const stream = await originalMedia.call(navigator.mediaDevices, constraints); streams.add(stream); return stream; };
        window.AudioContext = class extends OriginalContext { constructor(options?: AudioContextOptions) { super(options); contexts.add(this); contextIds.set(this, crypto.randomUUID()); } };
        window.AudioWorkletNode = class extends OriginalWorklet { constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options); this.port.addEventListener('message', () => { frames++; }); this.port.start();
        } };
        restoreMedia = () => { navigator.mediaDevices.getUserMedia = originalMedia; window.AudioContext = OriginalContext; window.AudioWorkletNode = OriginalWorklet; };
        reply(true, mediaSnapshot()); return;
      }
      if (value.operation === 'media-state') { reply(true, mediaSnapshot()); return; }
      if (value.operation === 'power-off') {
        const { powerOffJarvisInput } = await import('./voice/jarvis-power-authority'); powerOffJarvisInput(); await frame(); reply(true, mediaSnapshot()); return;
      }
      if (value.operation === 'media-cleanup') { restoreMedia?.(); restoreMedia = null; reply(true, mediaSnapshot()); return; }
      throw new Error('runtime UI operation refused');
    }).catch(() => reply(false));
  });
}
