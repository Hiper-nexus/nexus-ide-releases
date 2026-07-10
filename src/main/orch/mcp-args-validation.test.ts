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
