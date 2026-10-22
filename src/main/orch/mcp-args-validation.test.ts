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

  it('bounds browser_responsive devices to the three breakpoints', () => {
    expect(
      validateToolArgs('nexus_browser_responsive', { paneId: 'browser-1', devices: ['mobile', 'desktop'] }),
    ).toEqual({ paneId: 'browser-1', devices: ['mobile', 'desktop'] });
    expect(validateToolArgs('nexus_browser_responsive', { paneId: 'browser-1' })).toEqual({
      paneId: 'browser-1',
    });
    expect(() =>
      validateToolArgs('nexus_browser_responsive', { paneId: 'browser-1', devices: ['watch'] }),
    ).toThrow();
    expect(() =>
      validateToolArgs('nexus_browser_responsive', { paneId: 'browser-1', url: 'https://x.test' }),
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

describe('F-1088: advertised terminal sandbox profile contract',()=>{
  it.each(['workspace-only','workspace-net','yolo'])('accepts the existing advertised %s profile',sandboxProfile=>{
    expect(validateToolArgs('nexus_terminal_run',{command:'true',sandboxProfile})).toEqual({command:'true',sandboxProfile});
  });
  it.each(['unrestricted','',false,{},null])('rejects invalid profile %j',sandboxProfile=>{
    expect(()=>validateToolArgs('nexus_terminal_run',{command:'true',sandboxProfile})).toThrow();
  });
});

describe('F-1302: pane_spawn expect contract depth', () => {
  const realisticSchema = {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            severity: { enum: ['alta', 'media', 'baixa'] },
          },
        },
      },
    },
  };

  it('accepts a realistic expect.schema listing typed object fields', () => {
    const args = { provider: 'claude', expect: { retries: 2, schema: realisticSchema } };
    expect(validateToolArgs('nexus_pane_spawn', args)).toEqual(args);
  });

  it('accepts an expect.schema with anyOf branches', () => {
    const anyOfSchema = {
      type: 'object',
      properties: {
        result: {
          anyOf: [
            {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, score: { type: 'number' } },
                  },
                },
              },
            },
            { type: 'object', properties: { empty: { const: true } } },
          ],
        },
      },
    };
    const args = { expect: { schema: anyOfSchema } };
    expect(validateToolArgs('nexus_pane_spawn', args)).toEqual(args);
  });

  it('still rejects a pathologically deep payload', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 40; i += 1) {
      node.next = {};
      node = node.next as Record<string, unknown>;
    }
    expect(() => validateToolArgs('nexus_pane_spawn', { expect: deep })).toThrow(
      /exceed max depth/,
    );
  });
});

describe('fields advertised by the tool schema are accepted', () => {
  it('accepts focus, paneId, judge, holdMs and the file_search budgets', () => {
    expect(validateToolArgs('nexus_browser_read', { paneId: 'b', focus: 'qual o preço?' }))
      .toEqual({ paneId: 'b', focus: 'qual o preço?' });
    expect(validateToolArgs('nexus_browser_open', { url: 'https://a.test', paneId: 'b' }))
      .toEqual({ url: 'https://a.test', paneId: 'b' });
    expect(validateToolArgs('nexus_browser_find', { paneId: 'b', text: 'Salvar', judge: false }))
      .toEqual({ paneId: 'b', text: 'Salvar', judge: false });
    expect(validateToolArgs('nexus_browser_press', { paneId: 'b', key: 'ArrowUp', holdMs: 80 }))
      .toEqual({ paneId: 'b', key: 'ArrowUp', holdMs: 80 });
    expect(() => validateToolArgs('nexus_browser_press', { paneId: 'b', key: 'a', holdMs: 1_001 }))
      .toThrow();
    expect(validateToolArgs('nexus_file_search', {
      pattern: '**/*.ts', maxFiles: 500, maxDirectories: 50, timeoutMs: 2_000,
    })).toEqual({ pattern: '**/*.ts', maxFiles: 500, maxDirectories: 50, timeoutMs: 2_000 });
  });
});

describe('browser history through navigate', () => {
  it('accepts exactly one of url or history', () => {
    expect(validateToolArgs('nexus_browser_navigate', { paneId: 'b', history: 'back' }))
      .toEqual({ paneId: 'b', history: 'back' });
    expect(() => validateToolArgs('nexus_browser_navigate', { paneId: 'b' })).toThrow();
    expect(() => validateToolArgs('nexus_browser_navigate', { paneId: 'b', url: 'https://a.test', history: 'reload' }))
      .toThrow();
    expect(() => validateToolArgs('nexus_browser_navigate', { paneId: 'b', history: 'home' })).toThrow();
  });
});
