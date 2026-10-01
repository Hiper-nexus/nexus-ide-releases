import { describe, expect, it } from 'vitest';
import {
  claudeFamilyHubMcpServers,
  codexHubMcpArgs,
  selectHubServersForSpawn,
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

describe('selectHubServersForSpawn — helpers enxutos', () => {
  const hub = [stdio('firecrawl'), stdio('node_repl'), stdio('computer-use')];

  it('pane do operador e pane de missão recebem o hub inteiro', () => {
    expect(selectHubServersForSpawn(hub, { operatorChild: false, allowedTools: null }))
      .toBe(hub);
  });

  it('helper aberto por agente nasce sem os servidores do hub', () => {
    expect(selectHubServersForSpawn(hub, { operatorChild: true, allowedTools: null }))
      .toEqual([]);
    expect(selectHubServersForSpawn(hub, { operatorChild: true, allowedTools: ['Read', 'nexus_file_read'] }))
      .toEqual([]);
  });

  it('recebe só o servidor cujas tools o allowlist nomeia', () => {
    const picked = selectHubServersForSpawn(hub, {
      operatorChild: true,
      allowedTools: ['mcp__node_repl__js', 'mcp__user-computer-use__click'],
    });
    expect(picked.map((server) => server.key)).toEqual(['node_repl', 'computer-use']);
  });
});

describe('selectHubServersForSpawn — pane de missão (F-247)', () => {
  const remoteAuthed = (key: string): McpHubSpawnServer => ({
    ...http(key, `https://mcp.example.com/${key}`),
    headers: { authorization: 'Bearer x' },
  });
  const hub = [
    stdio('firecrawl'),
    stdio('github'),
    remoteAuthed('sentry'),
    http('higgsfield', 'https://mcp.example.com/higgsfield'),
  ];

  it('worker de missão sem allowedTools não recebe nenhum servidor do hub', () => {
    expect(
      selectHubServersForSpawn(hub, { operatorChild: false, allowedTools: null, role: 'worker' }),
    ).toEqual([]);
  });

  it('worker de missão recebe só o MCP do hub pedido no allowedTools', () => {
    const picked = selectHubServersForSpawn(hub, {
      operatorChild: false,
      allowedTools: ['mcp__github__*', 'Read'],
      role: 'worker',
    });
    expect(picked.map((server) => server.key)).toEqual(['github']);
  });

  it('orquestrador recebe stdio + remotos autenticados; remoto OAuth sem headers fica fora', () => {
    const picked = selectHubServersForSpawn(hub, {
      operatorChild: false,
      allowedTools: null,
      role: 'orchestrator',
    });
    expect(picked.map((server) => server.key)).toEqual(['firecrawl', 'github', 'sentry']);
  });

  it('pane do operador (user/sem role) continua recebendo o hub inteiro', () => {
    expect(selectHubServersForSpawn(hub, { operatorChild: false, allowedTools: null, role: 'user' }))
      .toBe(hub);
    expect(selectHubServersForSpawn(hub, { operatorChild: false, allowedTools: null }))
      .toBe(hub);
  });

  it('operatorChild inalterado: só o que o allowlist pede', () => {
    expect(
      selectHubServersForSpawn(hub, {
        operatorChild: true,
        allowedTools: ['mcp__sentry__*'],
        role: 'user',
      }).map((server) => server.key),
    ).toEqual(['sentry']);
  });
});
