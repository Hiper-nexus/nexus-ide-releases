import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeFamilyHubMcpServers,
  codexHubMcpArgs,
  loadMcpHubServersForSpawn,
  selectHubServersForSpawn,
  type McpHubSpawnServer,
} from './mcp-hub-spawn';
import {
  mcpHubVaultScope,
  sealMcpHubSecretsInMemory,
} from './mcp-hub-secrets';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function workspaceWithHub(servers: unknown[]): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-spawn-'));
  tempDirs.push(workspace);
  fs.mkdirSync(path.join(workspace, '.nexus'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.nexus', 'mcp-hub.json'),
    JSON.stringify({ schemaVersion: 1, servers }, null, 2),
  );
  return workspace;
}

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

describe('loadMcpHubServersForSpawn — F-1365/F-1366', () => {
  it('F-1365: hub legado com command "npx @playwright/mcp@latest" chega ao spawn partido', () => {
    // Campo 2026-10-11: sessão Claude com `posix_spawn 'npx @playwright/mcp@latest'`
    // (ENOENT) — o hub importou do Cursor o command como string única e o spawn
    // repassou sem partir. Aqui o hub JÁ contém a forma legada: o spawn parte.
    const workspace = workspaceWithHub([
      {
        id: 'playwright',
        name: 'Playwright',
        transport: 'stdio',
        command: 'npx @playwright/mcp@latest',
        tools: [],
        source: 'cursor',
      },
    ]);
    const servers = loadMcpHubServersForSpawn(workspace);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.command).toBe('npx');
    expect(servers[0]?.args).toEqual(['@playwright/mcp@latest']);
    const claude = claudeFamilyHubMcpServers(servers) as Record<
      string,
      { command?: string; args?: string[] }
    >;
    expect(claude.playwright?.command).toBe('npx');
    expect(claude.playwright?.args).toEqual(['@playwright/mcp@latest']);
  });

  it('F-1366: servidor com cwd chega ao spawn com o mesmo cwd', () => {
    const workspace = workspaceWithHub([
      {
        id: 'computer-use-client',
        name: 'computer-use-client',
        transport: 'stdio',
        command: './SkyComputerUseClient',
        args: ['mcp'],
        cwd: '/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS',
        tools: [],
        source: 'codex',
      },
    ]);
    const servers = loadMcpHubServersForSpawn(workspace);
    expect(servers[0]?.cwd).toBe(
      '/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS',
    );
  });

  it('F-1366: família Claude resolve command relativo contra o cwd (formato sem cwd)', () => {
    // Claude Code não tem campo `cwd` no .mcp.json (docs 2026-10): entrada
    // com campo desconhecido pode ser pulada no boot. O caminho relativo é
    // resolvido para absoluto em vez de emitir cwd.
    const servers = loadMcpHubServersForSpawn(
      workspaceWithHub([
        {
          id: 'computer-use-client',
          name: 'computer-use-client',
          transport: 'stdio',
          command: './SkyComputerUseClient',
          args: ['mcp'],
          cwd: '/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS',
          tools: [],
          source: 'codex',
        },
      ]),
    );
    const claude = claudeFamilyHubMcpServers(servers) as Record<
      string,
      { command?: string; cwd?: unknown }
    >;
    expect(claude['computer-use-client']?.command).toBe(
      '/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient',
    );
    expect(claude['computer-use-client']?.cwd).toBeUndefined();
    const codex = codexHubMcpArgs(servers).join(' ');
    expect(codex).toContain('mcp_servers.computer-use-client.cwd=');
  });
});

describe('loadMcpHubServersForSpawn — F-1383: args selados no cofre', () => {
  const FIGMA_ARG = `--figma-api-key=figd_${'X'.repeat(56)}`;

  function sealedFigmaWorkspace(): {
    workspace: string;
    store: Map<string, string>;
    ref: string;
  } {
    const store = new Map<string, string>();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-spawn-'));
    tempDirs.push(workspace);
    fs.mkdirSync(path.join(workspace, '.nexus'), { recursive: true });
    const scope = mcpHubVaultScope(workspace);
    const sealed = sealMcpHubSecretsInMemory(
      {
        schemaVersion: 1,
        servers: [
          {
            id: 'figma',
            name: 'Figma',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'figma-mcp', FIGMA_ARG],
            tools: [],
            source: 'claude-code',
          },
        ],
      },
      scope,
      store,
    );
    fs.writeFileSync(
      path.join(workspace, '.nexus', 'mcp-hub.json'),
      JSON.stringify(sealed, null, 2),
    );
    return { workspace, store, ref: sealed.servers[0]?.args?.[2] ?? '' };
  }

  it('resolve a ref de cofre do arg para o valor real no spawn', () => {
    const { workspace, store, ref } = sealedFigmaWorkspace();
    expect(ref.startsWith('__nexus_vault__:')).toBe(true);
    const servers = loadMcpHubServersForSpawn(workspace, {
      secretGet: (key) => store.get(key) ?? null,
    });
    expect(servers[0]?.args).toEqual(['-y', 'figma-mcp', FIGMA_ARG]);
    const claude = claudeFamilyHubMcpServers(servers) as Record<
      string,
      { args?: string[] }
    >;
    expect(claude.figma?.args).toEqual(['-y', 'figma-mcp', FIGMA_ARG]);
  });

  it('sem resolvedor o arg-ref é descartado (nunca vaza a ref no config gerado)', () => {
    const { workspace } = sealedFigmaWorkspace();
    const servers = loadMcpHubServersForSpawn(workspace);
    expect(servers[0]?.args).toEqual(['-y', 'figma-mcp']);
    expect(JSON.stringify(servers)).not.toContain('__nexus_vault__');
    expect(JSON.stringify(servers)).not.toContain('figd_');
  });

  it('flag de credencial com valor-ref descartada leva a flag junto', () => {
    const store = new Map<string, string>();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-spawn-'));
    tempDirs.push(workspace);
    fs.mkdirSync(path.join(workspace, '.nexus'), { recursive: true });
    const scope = mcpHubVaultScope(workspace);
    const sealed = sealMcpHubSecretsInMemory(
      {
        schemaVersion: 1,
        servers: [
          {
            id: 'figma',
            name: 'Figma',
            transport: 'stdio',
            command: 'figma-mcp',
            args: ['--token', 'opaque-token-value-123456', '--verbose'],
            tools: [],
            source: 'claude-code',
          },
        ],
      },
      scope,
      store,
    );
    fs.writeFileSync(
      path.join(workspace, '.nexus', 'mcp-hub.json'),
      JSON.stringify(sealed, null, 2),
    );
    const servers = loadMcpHubServersForSpawn(workspace);
    expect(servers[0]?.args).toEqual(['--verbose']);
  });
});

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
