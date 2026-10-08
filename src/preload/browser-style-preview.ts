/**
 * Optimistic style preview for design mode (VISUAL-EDIT-001, F2 — espelho do
 * padrão css-manager do Onlook, design apenas): a managed <style> element
 * holds ONE rule per selector, every declaration `!important`, so edits win
 * over the page's CSS without touching user DOM attributes. When the REAL
 * change lands (agent edited the code → HMR mutates/replaces the element),
 * a MutationObserver drops that selector's preview — consistência eventual.
 */

type BrowserDomWindow = Window & typeof globalThis;

export const STYLE_PREVIEW_HOST_ID = 'nexus-design-style-preview';

const MAX_SELECTOR_CHARS = 1_024;
const MAX_PROPERTIES = 64;
const MAX_VALUE_CHARS = 512;
const PROPERTY_PATTERN = /^-?[a-z][a-z-]*$/;
/* eslint-disable-next-line no-control-regex -- valores CSS com controle C0 são recusados de propósito */
const UNSAFE_VALUE = /[{};\u0000-\u001f]|<\/|\burl\s*\(/i;

export interface StylePreviewController {
  set(
    selector: string,
    styles: Record<string, string>,
  ): { applied: true; selector: string; properties: number };
  clear(selector?: string): { cleared: number };
  activeSelectors(): string[];
  dispose(): void;
}

export function createStylePreview(win: BrowserDomWindow): StylePreviewController {
  const doc = win.document;
  /** selector → (property → value), every entry already validated. */
  const rules = new Map<string, Map<string, string>>();
  let host: HTMLStyleElement | null = null;
  let observer: MutationObserver | null = null;

  function ensureHost(): HTMLStyleElement {
    if (host?.isConnected) return host;
    host?.remove();
    host = doc.createElement('style');
    host.id = STYLE_PREVIEW_HOST_ID;
    (doc.head ?? doc.documentElement).appendChild(host);
    return host;
  }

  function render(): void {
    if (rules.size === 0) {
      // Keep the (empty) host; it only leaves the DOM on dispose.
      if (host?.sheet) {
        while (host.sheet.cssRules.length) host.sheet.deleteRule(0);
      }
      syncObserver();
      return;
    }
    const sheet = ensureHost().sheet;
    if (!sheet) return;
    while (sheet.cssRules.length) sheet.deleteRule(0);
    for (const [selector, declarations] of rules) {
      const block = [...declarations]
        .map(([property, value]) => `${property}: ${value} !important;`)
        .join(' ');
      try {
        sheet.insertRule(`${selector} { ${block} }`, sheet.cssRules.length);
      } catch {
        // A selector the engine refuses at insert time is silently dropped.
        rules.delete(selector);
      }
    }
    syncObserver();
  }

  function matchesAnySelector(node: Node): string | null {
    if (!(node instanceof win.Element)) return null;
    for (const selector of rules.keys()) {
      try {
        if (node.matches(selector)) return selector;
      } catch {
        // Selector became invalid for matching — ignore.
      }
    }
    return null;
  }

  function onMutations(mutations: MutationRecord[]): void {
    const stale = new Set<string>();
    for (const mutation of mutations) {
      const target = mutation.target;
      if (host && (target === host || host.contains(target))) continue;
      if (mutation.type === 'attributes') {
        const selector = matchesAnySelector(target);
        if (selector) stale.add(selector);
      } else if (mutation.type === 'childList') {
        for (const removed of mutation.removedNodes) {
          const selector = matchesAnySelector(removed);
          if (selector) stale.add(selector);
        }
      }
    }
    if (!stale.size) return;
    for (const selector of stale) rules.delete(selector);
    render();
  }

  function syncObserver(): void {
    if (rules.size > 0 && !observer) {
      observer = new win.MutationObserver(onMutations);
      observer.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class'],
        childList: true,
        subtree: true,
      });
    } else if (rules.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function validateSelector(selector: unknown): string {
    if (
      typeof selector !== 'string' ||
      !selector.trim() ||
      selector.length > MAX_SELECTOR_CHARS
    ) {
      throw new Error('invalid style preview selector');
    }
    try {
      doc.querySelector(selector);
    } catch {
      throw new Error('invalid style preview selector');
    }
    return selector;
  }

  function validateStyles(styles: Record<string, string>): Array<[string, string]> {
    const entries = Object.entries(styles);
    if (!entries.length || entries.length > MAX_PROPERTIES) {
      throw new Error('invalid style preview: 1..64 properties required');
    }
    for (const [property, value] of entries) {
      if (!PROPERTY_PATTERN.test(property)) {
        throw new Error(`invalid style property: ${property.slice(0, 64)}`);
      }
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > MAX_VALUE_CHARS ||
        UNSAFE_VALUE.test(value)
      ) {
        throw new Error(`invalid style value for ${property}`);
      }
    }
    return entries;
  }

  return {
    set(selector, styles) {
      const safeSelector = validateSelector(selector);
      const entries = validateStyles(styles);
      // Merge per property: field-by-field sidebar edits accumulate into one
      // rule per selector instead of the last edit clobbering the others.
      const declarations = rules.get(safeSelector) ?? new Map<string, string>();
      for (const [property, value] of entries) {
        declarations.set(property, value);
      }
      while (declarations.size > MAX_PROPERTIES) {
        const oldest = declarations.keys().next().value as string;
        declarations.delete(oldest);
      }
      rules.set(safeSelector, declarations);
      render();
      return {
        applied: true,
        selector: safeSelector,
        properties: declarations.size,
      };
    },

    clear(selector) {
      let cleared = 0;
      if (selector === undefined) {
        cleared = rules.size;
        rules.clear();
      } else if (rules.delete(selector)) {
        cleared = 1;
      }
      render();
      return { cleared };
    },

    activeSelectors() {
      return [...rules.keys()];
    },

    dispose() {
      rules.clear();
      observer?.disconnect();
      observer = null;
      host?.remove();
      host = null;
    },
  };
}
