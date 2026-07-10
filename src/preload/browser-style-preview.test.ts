import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STYLE_PREVIEW_HOST_ID,
  createStylePreview,
} from './browser-style-preview';

type BrowserDomWindow = Window & typeof globalThis;

let dom: JSDOM | null = null;

function fixture(): { win: BrowserDomWindow; document: Document } {
  dom = new JSDOM(
    `<!doctype html><html><body>
      <button id="save" class="btn" style="color: rgb(255, 0, 0)">Salvar</button>
      <p class="lead">texto</p>
    </body></html>`,
    { url: 'http://localhost:5173/', pretendToBeVisual: true },
  );
  const win = dom.window as unknown as BrowserDomWindow;
  return { win, document: win.document };
}

afterEach(() => {
  dom?.window.close();
  dom = null;
});

function previewRules(document: Document): string[] {
  const host = document.getElementById(STYLE_PREVIEW_HOST_ID) as HTMLStyleElement | null;
  if (!host?.sheet) return [];
  return [...host.sheet.cssRules].map((rule) => rule.cssText);
}

describe('createStylePreview', () => {
  it('applies a managed rule per selector with !important', () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    const result = preview.set('#save', {
      'background-color': '#16a34a',
      'padding-top': '12px',
    });
    expect(result).toEqual({ applied: true, selector: '#save', properties: 2 });
    const rules = previewRules(document);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('#save');
    expect(rules[0]).toContain('background-color: rgb(22, 163, 74) !important');
    expect(rules[0]).toContain('padding-top: 12px !important');
  });

  it('replaces the rule for the same selector instead of stacking', () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    preview.set('#save', { color: '#fff' });
    preview.set('#save', { color: '#000' });
    const rules = previewRules(document);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('rgb(0, 0, 0)');
  });

  it('merges different properties for the same selector across calls (field-by-field edits)', () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    preview.set('#save', { 'padding-top': '24px' });
    preview.set('#save', { 'background-color': '#9333ea' });
    const rules = previewRules(document);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('padding-top: 24px !important');
    expect(rules[0]).toContain('background-color: rgb(147, 51, 234) !important');
  });

  it('keeps independent selectors as independent rules and clears one at a time', () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    preview.set('#save', { color: '#fff' });
    preview.set('.lead', { 'font-size': '20px' });
    expect(previewRules(document)).toHaveLength(2);
    preview.clear('#save');
    const rules = previewRules(document);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('.lead');
    preview.clear();
    expect(previewRules(document)).toHaveLength(0);
  });

  it('rejects unsafe property names and CSS-escaping values', () => {
    const { win } = fixture();
    const preview = createStylePreview(win);
    expect(() => preview.set('#save', { 'behavior;}': 'x' })).toThrow(/invalid style property/i);
    expect(() => preview.set('#save', { color: 'red} #save{background:url(evil)' })).toThrow(
      /invalid style value/i,
    );
    expect(() => preview.set('x'.repeat(2000), { color: 'red' })).toThrow(/selector/i);
  });

  it('clears the selector preview when the real element mutates (HMR reconciliation)', async () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    preview.set('#save', { 'background-color': '#16a34a' });
    expect(previewRules(document)).toHaveLength(1);

    // HMR delivers the real change: the app rewrites the element's style attr.
    document.getElementById('save')!.setAttribute('style', 'color: rgb(0, 128, 0)');
    await vi.waitFor(() => {
      expect(previewRules(document)).toHaveLength(0);
    });
  });

  it('ignores mutations on unrelated elements', async () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    preview.set('#save', { color: '#fff' });
    document.querySelector('.lead')!.setAttribute('style', 'color: blue');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(previewRules(document)).toHaveLength(1);
  });

  it('dispose removes the style host and the observer', () => {
    const { win, document } = fixture();
    const preview = createStylePreview(win);
    preview.set('#save', { color: '#fff' });
    preview.dispose();
    expect(document.getElementById(STYLE_PREVIEW_HOST_ID)).toBeNull();
  });
});
