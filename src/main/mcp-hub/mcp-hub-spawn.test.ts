import { describe, expect, it } from 'vitest';
import {
  claudeFamilyHubMcpServers,
  codexHubMcpArgs,
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

function http(key: string, url: string): McpHubSpawnServer {
  return {
    key,
    transport: 'streamable-http',
    url,
    args: [],
    headers: {},
    env: {},
  };
}

describe('codexHubMcpArgs — colisão com mcp_servers preservados', () => {
  it('omite o hub HTTP quando o mesmo nome já existe no config do operador', () => {
    // Campo 2026-09-19: ~/.codex tem [mcp_servers.supabase] stdio (command) e
    // o hub declara supabase streamable-http (url). O -c parcial somava url
    // no stdio e o Codex saía com "url is not supported for stdio".
    const args = codexHubMcpArgs(
      [http('supabase', 'https://mcp.supabase.com/mcp'), stdio('context7')],
      { skipKeys: ['supabase'] },
    ).join(' ');
    expect(args).not.toContain('mcp_servers.supabase');
    expect(args).toContain('mcp_servers.context7.command=');
  });

  it('sem skipKeys continua injetando o url do hub', () => {
    const args = codexHubMcpArgs([
      http('supabase', 'https://mcp.supabase.com/mcp'),
    ]).join(' ');
    expect(args).toContain(
      'mcp_servers.supabase.url="https://mcp.supabase.com/mcp"',
    );
  });
});
