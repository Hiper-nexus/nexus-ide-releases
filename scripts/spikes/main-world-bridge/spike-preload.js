/**
 * Spike preload (VISUAL-EDIT-001, Fase 0.4). Runs in the ISOLATED world of a
 * sandboxed WebContentsView (same webPreferences as browser-manager). Proves:
 *  1. framework expandos (__reactFiber$*) are INVISIBLE from this world;
 *  2. webFrame.executeJavaScript reaches the MAIN world and reads them.
 */
const { ipcRenderer, webFrame } = require('electron');

const MAIN_WORLD_PROBE = `(() => {
  const el = document.getElementById('save');
  if (!el) return { ok: false, error: 'no #save element' };
  const fiberKeys = Object.keys(el).filter((k) =>
    k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'),
  );
  const fiberKey = fiberKeys.find((k) => k.startsWith('__reactFiber$'));
  let componentName = null;
  if (fiberKey) {
    let fiber = el[fiberKey];
    for (let depth = 0; fiber && depth < 20; depth += 1) {
      const type = fiber.type;
      const name = (type && (type.displayName || type.name)) || null;
      if (typeof type === 'function' && name) { componentName = name; break; }
      fiber = fiber.return;
    }
  }
  return { ok: true, fiberKeys, componentName };
})()`;

function isolatedWorldSeesFiber() {
  const el = document.getElementById('save');
  if (!el) return { ok: false, error: 'no #save element (isolated)' };
  const fiberKeys = Object.keys(el).filter((k) => k.startsWith('__reactFiber$'));
  return { ok: true, fiberKeys };
}

async function run() {
  // Give React a tick to mount after load.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const report = {
    webFrameAvailable: Boolean(webFrame && typeof webFrame.executeJavaScript === 'function'),
    isolated: null,
    mainWorld: null,
    error: null,
  };
  try {
    report.isolated = isolatedWorldSeesFiber();
    report.mainWorld = await webFrame.executeJavaScript(MAIN_WORLD_PROBE);
  } catch (err) {
    report.error = err && err.message ? err.message : String(err);
  }
  ipcRenderer.send('spike:result', report);
}

window.addEventListener('load', () => {
  void run();
});
