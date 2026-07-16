/**
 * Testes da descoberta universal de configs (entrega B4).
 * Fixtures em tmpdir: workspace com .claude/ e .cursor/, home isolada.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverWorkspaceConfigs,
  invalidateWorkspaceDiscoveryCache,
  listDiscoveredMcpServersForHub,
  maskWorkspaceDiscoveryForUi,
} from './workspace-discovery-service';

const tempDirs: string[] = [];

afterEach(() => {
  invalidateWorkspaceDiscoveryCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFileDeep(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Workspace com .claude/ (mcp + skills + commands + CLAUDE.md) e .cursor/. */
function makeFixture(): { ws: string; home: string } {
  const ws = tmpDir('nexus-discovery-ws-');
  const home = tmpDir('nexus-discovery-home-');

  writeFileDeep(
    path.join(ws, '.claude', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'shared-mcp': {
          command: 'npx',
          args: ['-y', 'shared-server'],
          env: { API_TOKEN: '${NEXUS_TEST_TOKEN:-fallback-token}' },
        },
        'claude-only': { url: 'https://claude.example/mcp', type: 'http' },
      },
    }),
  );
  writeFileDeep(path.join(ws, '.claude', 'CLAUDE.md'), '# regras do projeto\n');
  writeFileDeep(
    path.join(ws, '.claude', 'skills', 'deploy-bot', 'SKILL.md'),
    '---\nname: deploy-bot\ndescription: Faz deploy com checklist\n---\n\n# corpo\n',
  );
  writeFileDeep(path.join(ws, '.claude', 'commands', 'ship.md'), 'Faça o ship.\n');
  writeFileDeep(
    path.join(ws, '.claude', 'commands', 'ops', 'restart.md'),
    'Reinicie o serviço.\n',
  );

  writeFileDeep(
    path.join(ws, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'shared-mcp': { command: 'cursor-shared-cmd' },
        'cursor-only': { command: 'cursor-cmd' },
      },
    }),
  );
  writeFileDeep(
    path.join(ws, '.cursor', 'rules', 'style.mdc'),
    '---\ndescription: estilo\n---\nUse aspas simples.\n',
  );

  return { ws, home };
}

describe('discoverWorkspaceConfigs', () => {
  it('descobre as 4 categorias com sources e levels corretos', () => {
    const { ws, home } = makeFixture();
    const result = discoverWorkspaceConfigs(ws, { home, env: {} });

    // MCP: exclusivos de cada ecossistema mantêm a atribuição correta.
    const claudeOnly = result.mcpServers.find((s) => s.name === 'claude-only');
    expect(claudeOnly?.source).toBe('claude');
    expect(claudeOnly?.level).toBe('project');
    expect(claudeOnly?.url).toBe('https://claude.example/mcp');
    expect(claudeOnly?.transport).toBe('http');
    const cursorOnly = result.mcpServers.find((s) => s.name === 'cursor-only');
    expect(cursorOnly?.source).toBe('cursor');

    // Context/rule files: CLAUDE.md (claude) e style.mdc (cursor, rule).
    const claudeMd = result.contextFiles.find((f) => f.name === 'CLAUDE.md');
    expect(claudeMd?.source).toBe('claude');
    expect(claudeMd?.level).toBe('project');
    expect(claudeMd?.kind).toBe('context');
    const rule = result.contextFiles.find((f) => f.name === 'style.mdc');
    expect(rule?.source).toBe('cursor');
    expect(rule?.kind).toBe('rule');

    // Skills: nome do frontmatter, source claude.
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: 'deploy-bot',
      source: 'claude',
      level: 'project',
      description: 'Faz deploy com checklist',
    });

    // Commands: raiz + aninhado com namespace ':'.
    const commandNames = result.commands.map((c) => c.name).sort();
    expect(commandNames).toEqual(['ops:restart', 'ship']);
    expect(result.commands.every((c) => c.source === 'claude')).toBe(true);
  });

  it('dedup de MCP server homônimo: claude vence cursor por prioridade', () => {
    const { ws, home } = makeFixture();
    const result = discoverWorkspaceConfigs(ws, { home, env: {} });

    const shared = result.mcpServers.filter((s) => s.name === 'shared-mcp');
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe('claude');
    expect(shared[0].command).toBe('npx'); // config do claude, não do cursor
  });

  it('expande env vars no config MCP (${VAR} e default ${VAR:-x})', () => {
    const { ws, home } = makeFixture();

    // Com a variável definida: usa o valor injetado.
    const withVar = discoverWorkspaceConfigs(ws, {
      home,
      env: { NEXUS_TEST_TOKEN: 'tok-123' },
    });
    const shared = withVar.mcpServers.find((s) => s.name === 'shared-mcp');
    expect(shared?.env?.API_TOKEN).toBe('tok-123');

    // Sem a variável: cai no default da sintaxe ${VAR:-fallback}.
    invalidateWorkspaceDiscoveryCache(ws);
    const withoutVar = discoverWorkspaceConfigs(ws, { home, env: {} });
    const sharedFallback = withoutVar.mcpServers.find(
      (s) => s.name === 'shared-mcp',
    );
    expect(sharedFallback?.env?.API_TOKEN).toBe('fallback-token');
  });

  it('default (sem env) NÃO materializa segredo do process.env em campo benigno', () => {
    const { ws, home } = makeFixture();
    // Segredo real no ambiente do processo, com o mesmo nome do ${VAR} do config.
    const prev = process.env.NEXUS_TEST_TOKEN;
    process.env.NEXUS_TEST_TOKEN = 'super-secret-from-process-env';
    try {
      // Chamada de produção NÃO passa env → default vazio: nada de process.env.
      const result = discoverWorkspaceConfigs(ws, { home });
      const shared = result.mcpServers.find((s) => s.name === 'shared-mcp');
      // Cai no fallback literal do config, jamais no valor do process.env.
      expect(shared?.env?.API_TOKEN).toBe('fallback-token');
      expect(JSON.stringify(result)).not.toContain('super-secret-from-process-env');
    } finally {
      if (prev === undefined) delete process.env.NEXUS_TEST_TOKEN;
      else process.env.NEXUS_TEST_TOKEN = prev;
    }
  });

  it('workspace vazio → listas vazias', () => {
    const ws = tmpDir('nexus-discovery-empty-ws-');
    const home = tmpDir('nexus-discovery-empty-home-');
    const result = discoverWorkspaceConfigs(ws, { home, env: {} });
    expect(result.mcpServers).toEqual([]);
    expect(result.contextFiles).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  it('cache: mesma referência sem mudanças; invalida quando o mtime muda', () => {
    const { ws, home } = makeFixture();
    const first = discoverWorkspaceConfigs(ws, { home, env: {} });
    const second = discoverWorkspaceConfigs(ws, { home, env: {} });
    // Fingerprint intacto → resultado cacheado (mesma referência).
    expect(second).toBe(first);

    // Reescreve o mcp.json com um server novo e força mtime distinto.
    const mcpPath = path.join(ws, '.claude', 'mcp.json');
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          'shared-mcp': { command: 'npx' },
          'claude-only': { url: 'https://claude.example/mcp', type: 'http' },
          'brand-new': { command: 'novo-cmd' },
        },
      }),
    );
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(mcpPath, future, future);

    const third = discoverWorkspaceConfigs(ws, { home, env: {} });
    expect(third).not.toBe(first);
    expect(third.mcpServers.some((s) => s.name === 'brand-new')).toBe(true);
  });

  it('cache invalida quando um arquivo novo aparece em diretório varrido', () => {
    const { ws, home } = makeFixture();
    const first = discoverWorkspaceConfigs(ws, { home, env: {} });
    expect(first.commands.map((c) => c.name)).not.toContain('release');

    // Arquivo novo muda o mtime do diretório de comandos já visitado.
    const newCommand = path.join(ws, '.claude', 'commands', 'release.md');
    fs.writeFileSync(newCommand, 'Faça o release.\n');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(path.dirname(newCommand), future, future);

    const second = discoverWorkspaceConfigs(ws, { home, env: {} });
    expect(second.commands.map((c) => c.name)).toContain('release');
  });

  it('rejeita workspaceRoot relativo', () => {
    expect(() => discoverWorkspaceConfigs('relativo/qualquer')).toThrow(
      /absoluto/,
    );
  });
});

describe('maskWorkspaceDiscoveryForUi', () => {
  it('mascara valores de env com chave que parece segredo, sem mutar o cache', () => {
    const { ws, home } = makeFixture();
    const result = discoverWorkspaceConfigs(ws, {
      home,
      env: { NEXUS_TEST_TOKEN: 'super-secret-value' },
    });
    const masked = maskWorkspaceDiscoveryForUi(result);

    const maskedShared = masked.mcpServers.find((s) => s.name === 'shared-mcp');
    expect(maskedShared?.env?.API_TOKEN).not.toContain('super-secret-value');
    expect(maskedShared?.env?.API_TOKEN).toContain('[REDACTED]');

    // O resultado cacheado permanece com o valor real (necessário pro hub).
    const original = result.mcpServers.find((s) => s.name === 'shared-mcp');
    expect(original?.env?.API_TOKEN).toBe('super-secret-value');
  });
});

describe('listDiscoveredMcpServersForHub', () => {
  it('mapeia para o formato canônico do hub com source/transport corretos', () => {
    const { ws, home } = makeFixture();
    const servers = listDiscoveredMcpServersForHub(ws, { home, env: {} });

    const shared = servers.find((s) => s.id === 'shared-mcp');
    expect(shared).toMatchObject({
      id: 'shared-mcp',
      transport: 'stdio',
      command: 'npx',
      source: 'claude-code',
      tools: [],
    });

    const remote = servers.find((s) => s.id === 'claude-only');
    expect(remote).toMatchObject({
      transport: 'streamable-http',
      url: 'https://claude.example/mcp',
    });

    const cursor = servers.find((s) => s.id === 'cursor-only');
    expect(cursor?.source).toBe('cursor');
  });
});
