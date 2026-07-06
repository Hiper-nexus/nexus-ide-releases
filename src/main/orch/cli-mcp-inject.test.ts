import { describe, expect, it } from 'vitest';
import {
  codexMcpArgs,
  geminiMcpFragment,
  mergeGeminiSettings,
  supportsMcpInjection,
} from './cli-mcp-inject';

describe('supportsMcpInjection', () => {
  it('reconhece codex/gemini/antigravity, ignora claude e shell', () => {
    expect(supportsMcpInjection('codex')).toBe('codex');
    expect(supportsMcpInjection('gemini')).toBe('gemini');
    expect(supportsMcpInjection('agy')).toBe('gemini');
    expect(supportsMcpInjection('claude')).toBe(null);
    expect(supportsMcpInjection('shell')).toBe(null);
    expect(supportsMcpInjection('kimi')).toBe(null);
  });
});

describe('codexMcpArgs', () => {
  it('gera overrides -c para url e header de autorização', () => {
    const args = codexMcpArgs('http://127.0.0.1:5123/mcp', 'tok-abc');
    expect(args).toContain('-c');
    const joined = args.join(' ');
    expect(joined).toContain('mcp_servers.nexus.url=');
    expect(joined).toContain('http://127.0.0.1:5123/mcp');
    expect(joined).toContain('Bearer tok-abc');
  });
});

describe('geminiMcpFragment', () => {
  it('usa httpUrl + header Authorization + trust', () => {
    const frag = geminiMcpFragment('http://127.0.0.1:5123/mcp', 'tok-abc');
    const nexus = frag.mcpServers.nexus;
    expect(nexus.httpUrl).toBe('http://127.0.0.1:5123/mcp');
    expect(nexus.headers.Authorization).toBe('Bearer tok-abc');
    expect(nexus.trust).toBe(true);
  });
});

describe('mergeGeminiSettings', () => {
  it('preserva chaves existentes e injeta o servidor nexus', () => {
    const existing = {
      theme: 'dark',
      mcpServers: { outra: { httpUrl: 'http://x' } },
    };
    const merged = mergeGeminiSettings(
      existing,
      geminiMcpFragment('http://u/mcp', 't'),
    );
    expect(merged.theme).toBe('dark');
    expect((merged.mcpServers as Record<string, unknown>).outra).toBeTruthy();
    expect((merged.mcpServers as Record<string, unknown>).nexus).toBeTruthy();
  });

  it('sobrescreve um nexus antigo (token rotaciona)', () => {
    const existing = {
      mcpServers: { nexus: { httpUrl: 'http://velho', headers: { Authorization: 'Bearer velho' } } },
    };
    const merged = mergeGeminiSettings(
      existing,
      geminiMcpFragment('http://novo/mcp', 'novo'),
    );
    const nexus = (merged.mcpServers as Record<string, { httpUrl: string }>).nexus;
    expect(nexus.httpUrl).toBe('http://novo/mcp');
  });

  it('base não-objeto vira objeto limpo', () => {
    const merged = mergeGeminiSettings(
      null,
      geminiMcpFragment('http://u/mcp', 't'),
    );
    expect((merged.mcpServers as Record<string, unknown>).nexus).toBeTruthy();
  });
});
