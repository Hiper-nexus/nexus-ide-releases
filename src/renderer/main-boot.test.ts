// Gate de boot do renderer: a página carrega em paralelo ao bootstrap do
// Main, mas o React só monta quando `window.nexus.app.ready()` resolve.
// Leitura estática — o comportamento vivo é exercido pelos smokes empacotados.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainTsx = fs.readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(
  new URL('../../index.html', import.meta.url),
  'utf8',
);

describe('renderer boot gate', () => {
  it('awaits window.nexus.app.ready() before createRoot().render', () => {
    // mountApp (que contém o createRoot) é o callback do .then do gate.
    const gate = mainTsx.indexOf('window.nexus.app.ready()');
    const mountCall = mainTsx.indexOf('.then(\n    mountApp');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(mountCall).toBeGreaterThan(gate);
    expect(mainTsx).toContain('createRoot(container).render(');
  });

  it('flags the gate wait so the mount watchdog sees a live page, not a stall', () => {
    expect(mainTsx).toContain('__nexusBootAwaiting');
  });

  it('removes the static splash when the gate resolves', () => {
    expect(mainTsx).toContain("'nexus-boot-splash'");
  });
});

describe('index.html static boot splash', () => {
  it('lives outside #root — the mount poll counts #root children only', () => {
    const splash = indexHtml.indexOf('id="nexus-boot-splash"');
    const root = indexHtml.indexOf('id="root"');
    expect(splash).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(splash);
    const afterRoot = indexHtml.slice(root);
    expect(afterRoot).not.toContain('nexus-boot-splash');
  });

  it('matches the native window background and honors reduced motion', () => {
    // #0b0b0c é o backgroundColor do BrowserWindow: a moldura e o splash
    // são um só campo escuro — sem piscada entre show e primeiro paint.
    expect(indexHtml).toContain('#0b0b0c');
    expect(indexHtml).toContain('prefers-reduced-motion');
  });

  it('ships no inline script — the packaged CSP forbids it', () => {
    expect(indexHtml).not.toMatch(/<script(?!\s+type="module")/u);
  });
});
