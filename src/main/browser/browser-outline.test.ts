import { describe, expect, it } from 'vitest';
import type { BrowserPageReadResult } from '../../shared/browser-automation';
import { renderBrowserOutline } from './browser-outline';

function read(overrides: Partial<BrowserPageReadResult> = {}): BrowserPageReadResult {
  return {
    url: 'https://example.test/app',
    title: 'Dashboard',
    readyState: 'complete',
    bodyText: 'Texto visível da página',
    truncated: false,
    headings: [
      { level: 1, text: 'Painel' },
      { level: 3, text: 'Subseção' },
    ],
    elements: [
      {
        ref: 'e12',
        tag: 'a',
        role: 'link',
        name: 'See the squads',
        href: '/en/squads',
      },
      {
        ref: 'e13',
        tag: 'button',
        role: 'button',
        name: 'Abrir menu',
      },
      {
        ref: 'e20',
        tag: 'input',
        role: 'textbox',
        name: 'Email',
        editable: true,
      },
      {
        ref: 'e21',
        tag: 'input',
        role: 'checkbox',
        name: 'Aceito',
        editable: true,
        checked: true,
      },
      {
        ref: 'e30',
        tag: 'button',
        role: 'button',
        name: 'Bloqueado',
        disabled: true,
      },
    ],
    viewport: { scrollY: 0, scrollHeight: 4_000, innerHeight: 800, pagesBelow: 4 },
    alerts: [],
    ...overrides,
  };
}

describe('renderBrowserOutline', () => {
  it('keeps every selected passage ahead of controls in a focused compact read', () => {
    const bodyText = 'primeiro trecho '.repeat(400) + 'ULTIMO TRECHO RELEVANTE';
    const outline = renderBrowserOutline(read({ bodyText,
      elements: Array.from({ length: 200 }, (_, i) => ({ ref: `e${i}`, tag: 'button', role: 'button', name: 'controle '.repeat(100) })),
    }), { preserveSelectedText: true });
    expect(outline).toContain(bodyText);
    expect(outline.indexOf('ULTIMO TRECHO RELEVANTE')).toBeLessThan(outline.indexOf('## elementos'));
    expect(outline.length).toBeLessThanOrEqual(bodyText.length + 3_030);
  });
  it('renders header, indented headings, elements, text and the tail line', () => {
    const outline = renderBrowserOutline(read());
    const lines = outline.split('\n');
    expect(lines[0]).toBe('https://example.test/app · Dashboard');
    expect(outline).toContain('## headings');
    expect(outline).toContain('\nPainel');
    expect(outline).toContain('\n    Subseção');
    expect(outline).toContain('[e12] link "See the squads" → /en/squads');
    expect(outline).toContain('[e13] button "Abrir menu"');
    expect(outline).toContain('[e20] textbox "Email" (editable)');
    expect(outline).toContain('[e21] checkbox "Aceito" (editable, checked)');
    expect(outline).toContain('[e30] button "Bloqueado" (disabled)');
    expect(outline).toContain('## texto');
    expect(outline).toContain('Texto visível da página');
    expect(outline).toContain('— 5 elementos, 4 telas abaixo');
  });

  it('keeps alerts and invalid fields in the compact outline, ahead of the element list', () => {
    const outline = renderBrowserOutline(read({
      alerts: [
        { ref: 'e20', role: 'textbox', text: 'Email' },
        { role: 'alert', text: 'Informe um e-mail válido' },
      ],
      elements: [
        { ref: 'e20', tag: 'input', role: 'textbox', name: 'Email', editable: true, invalid: true },
        ...Array.from({ length: 200 }, (_, i) => ({
          ref: `e${i + 100}`, tag: 'a', role: 'link', name: 'link '.repeat(20),
        })),
      ],
    }));
    expect(outline).toContain('## alertas');
    expect(outline).toContain('[e20] textbox: Email');
    expect(outline).toContain('alert: Informe um e-mail válido');
    expect(outline).toContain('[e20] textbox "Email" (editable, invalid)');
    expect(outline.indexOf('## alertas')).toBeLessThan(outline.indexOf('## elementos'));
  });

  it('flags expanded and selected state of menus, tabs and options', () => {
    const outline = renderBrowserOutline(read({
      elements: [
        { ref: 'e1', tag: 'button', role: 'button', name: 'Conta', expanded: true },
        { ref: 'e2', tag: 'button', role: 'tab', name: 'Planos', selected: true },
      ],
    }));
    expect(outline).toContain('[e1] button "Conta" (expanded)');
    expect(outline).toContain('[e2] tab "Planos" (selected)');
  });

  it('omits empty sections and the tail when the page is empty', () => {
    const outline = renderBrowserOutline(
      read({
        headings: [],
        elements: [],
        bodyText: '',
        viewport: { scrollY: 0, scrollHeight: 800, innerHeight: 800, pagesBelow: 0 },
      }),
    );
    expect(outline).toBe('https://example.test/app · Dashboard');
  });

  it('caps bodyText at 4.000 chars and the whole outline at 12.000 chars', () => {
    const outline = renderBrowserOutline(
      read({ bodyText: 'y'.repeat(20_000), elements: [], headings: [] }),
    );
    expect(outline.length).toBeLessThanOrEqual(12_000);
    expect((outline.match(/y/g) ?? []).length).toBeLessThanOrEqual(4_000);

    const many = renderBrowserOutline(
      read({
        elements: Array.from({ length: 200 }, (_, i) => ({
          ref: `e${i}`,
          tag: 'a',
          role: 'link',
          name: `Link ${i} `.repeat(10).trim(),
          href: `/p/${i}`,
        })),
      }),
    );
    expect(many.length).toBeLessThanOrEqual(12_000);
  });
});
