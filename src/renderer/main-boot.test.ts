// Gate de boot do renderer: a página carrega em paralelo ao bootstrap do
// Main, mas o React só monta quando `window.nexus.app.ready()` resolve.
// Leitura estática — o comportamento vivo é exercido pelos smokes empacotados.
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './components/ErrorBoundary';

const createRootMock = vi.hoisted(() => vi.fn());
const renderMock = vi.hoisted(() => vi.fn());

vi.mock('react-dom/client', () => ({
  createRoot: createRootMock,
}));
vi.mock('./App', () => ({
  App: () => null,
}));
vi.mock('./orch/restore-agents-gate', () => ({
  installRestoredAgentsGate: vi.fn(),
}));
vi.mock('./soak-smoke', () => ({
  installSoakRenderer: vi.fn(),
}));
vi.mock('./runtime-gates', () => ({
  installRuntimeGateRenderer: vi.fn(),
}));
vi.mock('./styles/global.css', () => ({}));

const mainTsx = fs.readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const errorBoundaryTsx = fs.readFileSync(
  new URL('./components/ErrorBoundary.tsx', import.meta.url),
  'utf8',
);
const windowTs = fs.readFileSync(
  new URL('../main/window.ts', import.meta.url),
  'utf8',
);
const indexHtml = fs.readFileSync(
  new URL('../../index.html', import.meta.url),
  'utf8',
);

describe('renderer boot gate', () => {
  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockReset();
    renderMock.mockReset();
    createRootMock.mockReturnValue({ render: renderMock });
  });

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

  it('removes the static splash on first React commit (ErrorBoundary.componentDidMount), not before createRoot', () => {
    expect(mainTsx).not.toContain('nexus-boot-splash');
    expect(errorBoundaryTsx).toContain("document.getElementById('nexus-boot-splash')?.remove()");
  });

  it('never mounts React or removes the splash when boot:ready rejects', async () => {
    const splashRemove = vi.fn();
    const signalMounted = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('document', {
      getElementById: vi.fn((id: string) => {
        if (id === 'root') return { id: 'root' };
        if (id === 'nexus-boot-splash') return { remove: splashRemove };
        return null;
      }),
    });
    vi.stubGlobal('window', {
      nexus: {
        app: {
          ready: vi.fn(() => Promise.reject(new Error('boot failed'))),
          signalMounted,
        },
      },
    });

    try {
      await import('./main');
      await Promise.resolve();
      await Promise.resolve();

      expect(createRootMock).not.toHaveBeenCalled();
      expect(renderMock).not.toHaveBeenCalled();
      expect(splashRemove).not.toHaveBeenCalled();
      expect(signalMounted).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('mounts immediately on reload after boot:ready has already resolved, removing the splash only on first commit', async () => {
    let splashInDom = true;
    const splashRemove = vi.fn(() => {
      splashInDom = false;
    });
    const signalMounted = vi.fn();
    let splashStillPresentAtCreateRoot = false;

    createRootMock.mockImplementation(() => {
      splashStillPresentAtCreateRoot = splashInDom;
      return {
        render: () => {
          const boundary = new ErrorBoundary({ children: null });
          boundary.componentDidMount();
        },
      };
    });

    const fakeWindow: Record<string, unknown> = {
      nexus: {
        app: {
          ready: vi.fn(() => Promise.resolve()),
          signalMounted,
        },
      },
    };
    vi.stubGlobal('document', {
      getElementById: vi.fn((id: string) => {
        if (id === 'root') return { id: 'root' };
        if (id === 'nexus-boot-splash') return splashInDom ? { remove: splashRemove } : null;
        return null;
      }),
    });
    vi.stubGlobal('window', fakeWindow);

    try {
      await import('./main');
      await Promise.resolve();

      expect(createRootMock).toHaveBeenCalledOnce();
      expect(splashStillPresentAtCreateRoot).toBe(true);
      expect(splashRemove).toHaveBeenCalledOnce();
      expect(splashInDom).toBe(false);
      expect(signalMounted).toHaveBeenCalledWith({ ok: true });
      expect(fakeWindow.__nexusBootAwaiting).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('uses var(--bg, #080709) coherent with BrowserWindow backgroundColor and honors reduced motion', () => {
    expect(indexHtml).toContain('var(--bg, #080709)');
    expect(indexHtml).not.toContain('#0b0b0c');
    expect(windowTs).toContain("backgroundColor: '#080709'");
    expect(indexHtml).toContain('prefers-reduced-motion');
    // Documenta por que o flash escuro inicial é aceito antes da hidratação do tema.
    expect(indexHtml).toMatch(/tema claro|flash escuro/iu);
  });

  it('ships no inline script — the packaged CSP forbids it', () => {
    expect(indexHtml).not.toMatch(/<script(?!\s+type="module")/u);
  });
});
