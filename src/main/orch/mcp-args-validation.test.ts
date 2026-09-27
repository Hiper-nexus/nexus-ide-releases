import { describe, expect, it } from 'vitest';
import { validateToolArgs } from './mcp-args-validation';

describe('browser MCP argument validation', () => {
  it('accepts bounded opaque element refs and an empty fill to clear a field', () => {
    expect(
      validateToolArgs('nexus_browser_fill', {
        paneId: 'browser-1',
        ref: 'e42',
        text: '',
      }),
    ).toEqual({ paneId: 'browser-1', ref: 'e42', text: '' });
  });

  it('rejects CSS selectors, arbitrary JavaScript fields and oversized page reads', () => {
    expect(() =>
      validateToolArgs('nexus_browser_click', {
        paneId: 'browser-1',
        ref: '#submit',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_click', {
        paneId: 'browser-1',
        ref: 'e1',
        script: 'document.cookie',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_read', {
        paneId: 'browser-1',
        maxChars: 20_001,
      }),
    ).toThrow();
  });

  it('requires the condition-specific wait argument and caps timeouts', () => {
    expect(() =>
      validateToolArgs('nexus_browser_wait', {
        paneId: 'browser-1',
        condition: 'text',
      }),
    ).toThrow(/value is required/);
    expect(() =>
      validateToolArgs('nexus_browser_wait', {
        paneId: 'browser-1',
        condition: 'ref',
        ref: '#ready',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_wait', {
        paneId: 'browser-1',
        condition: 'load',
        timeoutMs: 15_001,
      }),
    ).toThrow();
  });

  it('accepts text targets for click/fill and rejects ref+text together', () => {
    expect(
      validateToolArgs('nexus_browser_click', {
        paneId: 'browser-1',
        text: 'Ver squads',
      }),
    ).toEqual({ paneId: 'browser-1', text: 'Ver squads' });
    expect(
      validateToolArgs('nexus_browser_fill', {
        paneId: 'browser-1',
        label: 'Email',
        text: 'a@b.com',
      }),
    ).toEqual({ paneId: 'browser-1', label: 'Email', text: 'a@b.com' });
    expect(() =>
      validateToolArgs('nexus_browser_click', {
        paneId: 'browser-1',
        ref: 'e1',
        text: 'Ver squads',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_click', { paneId: 'browser-1' }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_fill', {
        paneId: 'browser-1',
        ref: 'e1',
        label: 'Email',
        text: 'x',
      }),
    ).toThrow();
  });

  it('accepts a device breakpoint on browser_navigate and rejects unknown values', () => {
    expect(
      validateToolArgs('nexus_browser_navigate', {
        paneId: 'browser-1',
        url: 'https://example.test',
        device: 'mobile',
      }),
    ).toEqual({
      paneId: 'browser-1',
      url: 'https://example.test',
      device: 'mobile',
    });
    expect(() =>
      validateToolArgs('nexus_browser_navigate', {
        paneId: 'browser-1',
        url: 'https://example.test',
        device: 'phone',
      }),
    ).toThrow();
  });

  it('accepts read/judge/format options and bounds extraction fields', () => {
    expect(
      validateToolArgs('nexus_browser_read', {
        paneId: 'browser-1',
        format: 'compact',
        judge: true,
      }),
    ).toEqual({ paneId: 'browser-1', format: 'compact', judge: true });
    expect(
      validateToolArgs('nexus_browser_click', {
        paneId: 'browser-1',
        ref: 'e1',
        read: { format: 'compact', maxChars: 500 },
      }),
    ).toEqual({
      paneId: 'browser-1',
      ref: 'e1',
      read: { format: 'compact', maxChars: 500 },
    });

    expect(
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [
          { name: 'total', type: 'number', hint: 'total do pedido' },
          { name: 'pagamento', type: 'enum', enum: ['pix', 'boleto'] },
        ],
      }),
    ).toEqual({
      paneId: 'browser-1',
      fields: [
        { name: 'total', type: 'number', hint: 'total do pedido' },
        { name: 'pagamento', type: 'enum', enum: ['pix', 'boleto'] },
      ],
    });
    expect(() =>
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [{ name: 'pagamento', type: 'enum' }],
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [],
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [{ name: 'x'.repeat(65), type: 'string' }],
      }),
    ).toThrow();
  });

  it('accepts description as a hint synonym without keeping both keys', () => {
    expect(
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [{ name: 'presidente', type: 'string', description: 'chefe de estado' }],
      }),
    ).toEqual({
      paneId: 'browser-1',
      fields: [{ name: 'presidente', type: 'string', hint: 'chefe de estado' }],
    });
    // hint wins when both are present.
    expect(
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [
          { name: 'presidente', type: 'string', hint: 'certo', description: 'ignorado' },
        ],
      }),
    ).toEqual({
      paneId: 'browser-1',
      fields: [{ name: 'presidente', type: 'string', hint: 'certo' }],
    });
    expect(() =>
      validateToolArgs('nexus_browser_extract', {
        paneId: 'browser-1',
        fields: [{ name: 'x', type: 'string', unexpectedKey: 'nope' }],
      }),
    ).toThrow();
  });
});

describe('Nexus UI MCP argument validation', () => {
  it('accepts only snapshot-scoped opaque refs and bounded actions', () => {
    expect(
      validateToolArgs('nexus_ui_action', {
        action: 'fill',
        ref: 'u12e4',
        text: 'Mission name',
      }),
    ).toEqual({ action: 'fill', ref: 'u12e4', text: 'Mission name' });

    expect(() =>
      validateToolArgs('nexus_ui_action', {
        action: 'click',
        ref: '#danger',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_ui_action', {
        action: 'script',
        ref: 'u1e1',
        text: 'document.cookie',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_ui_action', {
        action: 'click',
        ref: 'u1e1',
        text: 'not allowed for click',
      }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_ui_action', {
        action: 'select',
        ref: 'u1e1',
      }),
    ).toThrow(/text is required/);
  });
});

describe('BridgeMind audit MCP argument validation', () => {
  it('requires exactly one bounded audit target', () => {
    expect(
      validateToolArgs('nexus_content_audit', {
        content: 'external text',
        provenance: 'repo-untrusted',
      }),
    ).toEqual({ content: 'external text', provenance: 'repo-untrusted' });
    expect(() =>
      validateToolArgs('nexus_security_audit', { path: 'src/index.ts', content: 'also' }),
    ).toThrow(/exactly one/);
    expect(() =>
      validateToolArgs('nexus_content_audit', { provenance: 'repo-untrusted' }),
    ).toThrow(/exactly one/);
  });
});
