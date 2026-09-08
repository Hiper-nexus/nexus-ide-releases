import { describe, expect, it } from 'vitest';
import {
  claudeFamilyHubMcpServers,
  type McpHubSpawnServer,
} from './mcp-hub-spawn';

function stdio(key: string): McpHubSpawnServer {
  return {
    key,
    transport: 'stdio',
    command: '/usr/bin/mcp',
    args: [],
    headers: {},
    env: {},
  };
}

describe('claudeFamilyHubMcpServers — nomes reservados da CLI', () => {
  it('renomeia computer-use para nome carregável sem perder o servidor', () => {
    // Campo em 07/09/2026: o hub do operador tinha `computer-use` (Codex
    // Computer Use) e todo boot de worker cuspia `1 MCP server skipped due
    // to invalid config` — a CLI reserva o nome e o servidor caía em
    // silêncio. Renomear carrega as tools (sob outro nome) em vez de perder.
    const servers = claudeFamilyHubMcpServers([stdio('computer-use')]);
    const names = Object.keys(servers);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe('computer-use');
    expect(names[0]).toContain('computer-use');
    const entry = servers[names[0]!] as { command?: unknown };
    expect(entry.command).toBe('/usr/bin/mcp');
  });

  it('mantém servidores comuns intocados', () => {
    const servers = claudeFamilyHubMcpServers([
      stdio('github'),
      stdio('supabase'),
    ]);
    expect(Object.keys(servers)).toEqual(['github', 'supabase']);
  });

  it('resolve colisão do renome sem descartar servidor', () => {
    const servers = claudeFamilyHubMcpServers([
      stdio('computer-use'),
      stdio('user-computer-use'),
    ]);
    const names = Object.keys(servers);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('user-computer-use');
  });
});
