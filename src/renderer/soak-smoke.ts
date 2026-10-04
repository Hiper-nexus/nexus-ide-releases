import { SOAK_DOM_REPLY, SOAK_DOM_REQUEST, soakNonce, isSoakRendererUrl } from '../shared/soak-smoke';
import type { SoakUi } from '../preload/soak-smoke';

interface UiPorts {
  open(): Promise<string>; wait(id: string): Promise<string | null>; close(id: string): void | Promise<void>;
  view(id: string, marker: string, sequence: number): ReturnType<SoakUi['view']>;
}
// Capture at module startup: a later DOM event/history edit cannot opt a normal
// application page into test-only UI actions.
const eligibleAtStartup = typeof location !== 'undefined' && isSoakRendererUrl(location.href);
export function createSoakUi(ports: UiPorts): SoakUi {
  const owned = new Set<string>();
  return {
    async open() {
      if (owned.size) throw new Error('soak UI already has a pane');
      const paneId = await ports.open(); owned.add(paneId);
      try { const sessionId = await ports.wait(paneId); if (!sessionId) throw new Error('soak UI session unavailable'); return { paneId, sessionId }; }
      catch (error) { await ports.close(paneId); owned.delete(paneId); throw error; }
    },
    async view(paneId, marker, sequence) { if (!owned.has(paneId)) throw new Error('soak UI foreign pane'); return ports.view(paneId, marker, sequence); },
    async close(paneId) { if (!owned.has(paneId)) throw new Error('soak UI foreign pane'); await ports.close(paneId); owned.delete(paneId); },
  };
}
async function rendererUi(): Promise<SoakUi> {
  const [{ useLayoutStore }, { useProductNavigationStore }, terminal, { listPanes }] = await Promise.all([
    import('./state/layout-store'), import('./state/product-navigation-store'), import('./terminal/terminal-host'), import('./lib/split-tree'),
  ]);
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  return createSoakUi({
    async open() { useProductNavigationStore.getState().openTerminal(); await frame(); return useLayoutStore.getState().addShellPane(); },
    wait: id => terminal.waitForSession(id, 10000),
    async close(id) { useLayoutStore.getState().close(id, 'soak-smoke'); await frame(); await frame(); },
    async view(id, marker, sequence) {
      const pane = listPanes(useLayoutStore.getState().root).find(p => p.id === id);
      if (!pane) throw new Error('soak pane removed');
      const host = terminal.getOrCreateHost(pane), term = host.term, element = term.element;
      await frame(); await frame();
      const rect = element?.getBoundingClientRect();
      if (!element?.isConnected || !rect || rect.width <= 0 || rect.height <= 0 || getComputedStyle(element).visibility !== 'visible' ||
          rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth || document.visibilityState !== 'visible') throw new Error('soak xterm is not visible');
      const buffer = term.buffer.active;
      let renderedMarker = false;
      for (let line = Math.max(0, buffer.length - 128); line < buffer.length; line++) if (buffer.getLine(line)?.translateToString().includes(marker)) renderedMarker = true;
      if (!renderedMarker || buffer.baseY <= 0) throw new Error('soak rendered scrollback missing');
      term.resize(88 + sequence % 2 * 8, 24);
      term.scrollToTop(); await frame(); term.scrollToBottom(); await frame();
      const metrics = terminal.terminalRendererPerformanceSnapshot();
      if (metrics.visibleHosts < 1) throw new Error('soak terminal host not visible');
      const sessionId = terminal.getPaneSessionId(id);
      if (!sessionId) throw new Error('soak terminal session vanished');
      terminal.markPaneClosingDeliberately(id, sessionId);
      return { frames: 4, renderedMarker: true, scroll: true, resize: true, rendererHosts: metrics.hosts };
    },
  });
}
/** Dormant observer; only the private Main/preload smoke conversation uses it. */
export function installSoakRenderer(): void {
  if (!eligibleAtStartup) return;
  let ui: Promise<SoakUi> | null = null, nonce: string | null = null, tail = Promise.resolve();
  window.addEventListener(SOAK_DOM_REQUEST, event => {
    const raw = (event as CustomEvent).detail;
    if (!raw || typeof raw !== 'object' || !soakNonce.safeParse(raw.nonce).success || !Number.isSafeInteger(raw.request) || raw.request < 0 || raw.request > 300 ||
        !['open', 'view', 'close'].includes(raw.operation) || nonce && raw.nonce !== nonce) return;
    nonce ??= raw.nonce;
    const reply = (ok: boolean, value?: unknown) => window.dispatchEvent(new CustomEvent(SOAK_DOM_REPLY, { detail: { nonce, request: raw.request, ok, value } }));
    tail = tail.then(async () => {
      const controls = await (ui ??= rendererUi());
      if (raw.operation === 'open') reply(true, await controls.open());
      else {
        if (typeof raw.paneId !== 'string' || raw.paneId.length > 256) throw new Error('invalid soak pane');
        if (raw.operation === 'close') { await controls.close(raw.paneId); reply(true); }
        else {
          if (typeof raw.marker !== 'string' || raw.marker.length > 128 || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0 || raw.sequence > 79) throw new Error('invalid soak view');
          reply(true, await controls.view(raw.paneId, raw.marker, raw.sequence));
        }
      }
    }).catch(() => { reply(false); });
  });
}
