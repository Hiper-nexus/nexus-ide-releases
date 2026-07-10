import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { browserDesignFrameworkHintsSchema } from '../main/browser/browser-design-schema';
import {
  FRAMEWORK_PROBE_ATTR,
  buildFrameworkProbeSource,
  introspectElementFrameworks,
  sanitizeFrameworkHints,
} from './browser-framework-introspect';

type BrowserDomWindow = Window & typeof globalThis;

let dom: JSDOM | null = null;

function makeDom(html: string): { win: BrowserDomWindow; document: Document } {
  dom = new JSDOM(html, { url: 'http://localhost:5173/app' });
  const win = dom.window as unknown as BrowserDomWindow;
  return { win, document: win.document };
}

afterEach(() => {
  dom?.window.close();
  dom = null;
});

/**
 * Runs the probe source the way the MAIN world would: plain evaluation with
 * the page's `document` in scope. In production this string goes through
 * `webFrame.executeJavaScript` (spike PASS, Fase 0.4).
 */
function evalProbe(document: Document, source: string): unknown {
  return new Function('document', `return (${source});`)(document);
}

function markProbe(element: Element, nonce: string): void {
  element.setAttribute(FRAMEWORK_PROBE_ATTR, nonce);
}

interface FakeFiber {
  type: unknown;
  return: FakeFiber | null;
  memoizedProps?: Record<string, unknown>;
}

function plantReactFiber(element: Element): void {
  function SaveButton(): null {
    return null;
  }
  function Toolbar(): null {
    return null;
  }
  function App(): null {
    return null;
  }
  const appFiber: FakeFiber = { type: App, return: null };
  const toolbarFiber: FakeFiber = { type: Toolbar, return: appFiber };
  const saveFiber: FakeFiber = {
    type: SaveButton,
    return: toolbarFiber,
    memoizedProps: { label: 'Salvar', onClick: () => {}, children: 'x' },
  };
  const hostFiber: FakeFiber = {
    type: 'button',
    return: saveFiber,
    memoizedProps: { className: 'btn' },
  };
  (element as unknown as Record<string, unknown>).__reactFiber$abc123 = hostFiber;
}

describe('buildFrameworkProbeSource', () => {
  it('reads a react fiber chain: component, owner chain, prop keys (no values)', () => {
    const { document } = makeDom('<button id="save">Salvar</button>');
    const el = document.getElementById('save')!;
    plantReactFiber(el);
    markProbe(el, 'nonce1');

    const raw = evalProbe(document, buildFrameworkProbeSource('nonce1'));
    const hints = sanitizeFrameworkHints(raw);
    expect(hints).toBeDefined();
    expect(hints?.framework).toBe('react');
    expect(hints?.componentName).toBe('SaveButton');
    expect(hints?.ownerChain).toEqual(['SaveButton', 'Toolbar', 'App']);
    expect(hints?.propKeys).toContain('label');
    expect(hints?.propKeys).toContain('onClick');
    expect(hints?.propKeys).not.toContain('children');
    // The bridge payload must satisfy the main-process contract.
    expect(browserDesignFrameworkHintsSchema.safeParse(hints).success).toBe(true);
  });

  it('reads vue dev metadata: __vueParentComponent name and file', () => {
    const { document } = makeDom('<div id="card"></div>');
    const el = document.getElementById('card')!;
    (el as unknown as Record<string, unknown>).__vueParentComponent = {
      type: { __name: 'UserCard', __file: '/src/components/UserCard.vue' },
    };
    markProbe(el, 'nonce2');

    const hints = sanitizeFrameworkHints(
      evalProbe(document, buildFrameworkProbeSource('nonce2')),
    );
    expect(hints?.framework).toBe('vue');
    expect(hints?.componentName).toBe('UserCard');
    expect(hints?.source?.file).toBe('/src/components/UserCard.vue');
  });

  it('reads svelte dev metadata: __svelte_meta.loc file:line:column', () => {
    const { document } = makeDom('<p id="hero"></p>');
    const el = document.getElementById('hero')!;
    (el as unknown as Record<string, unknown>).__svelte_meta = {
      loc: { file: 'src/routes/+page.svelte', line: 12, column: 4 },
    };
    markProbe(el, 'nonce3');

    const hints = sanitizeFrameworkHints(
      evalProbe(document, buildFrameworkProbeSource('nonce3')),
    );
    expect(hints?.framework).toBe('svelte');
    expect(hints?.source).toEqual({
      file: 'src/routes/+page.svelte',
      line: 12,
      column: 4,
    });
  });

  it('returns null for plain pages (no framework internals)', () => {
    const { document } = makeDom('<span id="plain">text</span>');
    markProbe(document.getElementById('plain')!, 'nonce4');
    expect(evalProbe(document, buildFrameworkProbeSource('nonce4'))).toBeNull();
  });

  it('returns null when the probe target is gone', () => {
    const { document } = makeDom('<span>never marked</span>');
    expect(evalProbe(document, buildFrameworkProbeSource('nonce5'))).toBeNull();
  });
});

describe('sanitizeFrameworkHints', () => {
  it('clamps oversized values instead of leaking them across the bridge', () => {
    const hints = sanitizeFrameworkHints({
      framework: 'react',
      componentName: 'x'.repeat(500),
      ownerChain: Array.from({ length: 30 }, (_, i) => `C${i}`.repeat(80)),
      propKeys: Array.from({ length: 100 }, (_, i) => `p${i}`),
      source: { file: 'f'.repeat(3000), line: 5, column: 2 },
    });
    expect(hints).toBeDefined();
    expect(browserDesignFrameworkHintsSchema.safeParse(hints).success).toBe(true);
    expect(hints!.componentName!.length).toBeLessThanOrEqual(128);
    expect(hints!.ownerChain.length).toBeLessThanOrEqual(10);
    expect(hints!.propKeys!.length).toBeLessThanOrEqual(32);
    expect(hints!.source!.file.length).toBeLessThanOrEqual(1_024);
  });

  it('refuses non-object or unknown-framework payloads (page-tampered bridge)', () => {
    expect(sanitizeFrameworkHints(null)).toBeUndefined();
    expect(sanitizeFrameworkHints('react')).toBeUndefined();
    expect(sanitizeFrameworkHints({ framework: 'jquery', ownerChain: [] })).toBeUndefined();
    expect(sanitizeFrameworkHints({ ownerChain: [] })).toBeUndefined();
  });

  it('drops malformed optional fields but keeps the valid core', () => {
    const hints = sanitizeFrameworkHints({
      framework: 'react',
      componentName: 42,
      ownerChain: ['App', 7, 'Toolbar'],
      propKeys: 'not-an-array',
      source: { file: 9 },
    });
    expect(hints).toEqual({ framework: 'react', ownerChain: ['App', 'Toolbar'] });
  });
});

describe('introspectElementFrameworks', () => {
  it('marks the element, evaluates in the main world, then removes the marker', async () => {
    const { win, document } = makeDom('<button id="save">Salvar</button>');
    const el = document.getElementById('save')!;
    plantReactFiber(el);

    let sourceSeen = '';
    const hints = await introspectElementFrameworks(win, el, async (source) => {
      sourceSeen = source;
      // Attribute must be visible while the probe runs (shared DOM).
      expect(el.hasAttribute(FRAMEWORK_PROBE_ATTR)).toBe(true);
      return evalProbe(document, source);
    });
    expect(hints?.framework).toBe('react');
    expect(hints?.componentName).toBe('SaveButton');
    expect(sourceSeen).toContain(FRAMEWORK_PROBE_ATTR);
    // The transient marker never persists (rule: no attrs left in user DOM).
    expect(el.hasAttribute(FRAMEWORK_PROBE_ATTR)).toBe(false);
  });

  it('resolves undefined when the main world bridge fails', async () => {
    const { win, document } = makeDom('<button id="save"></button>');
    const el = document.getElementById('save')!;
    const hints = await introspectElementFrameworks(win, el, async () => {
      throw new Error('bridge unavailable');
    });
    expect(hints).toBeUndefined();
    expect(el.hasAttribute(FRAMEWORK_PROBE_ATTR)).toBe(false);
  });

  it('resolves undefined when the bridge hangs (picker must never freeze)', async () => {
    const { win, document } = makeDom('<button id="save"></button>');
    const el = document.getElementById('save')!;
    const hints = await introspectElementFrameworks(
      win,
      el,
      () => new Promise(() => {}),
      { timeoutMs: 20 },
    );
    expect(hints).toBeUndefined();
    expect(el.hasAttribute(FRAMEWORK_PROBE_ATTR)).toBe(false);
  });
});
