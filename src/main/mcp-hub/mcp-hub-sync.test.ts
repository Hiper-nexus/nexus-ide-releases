import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  applyMcpSync,
  collectObservedHubServers,
  planMcpSync,
  __testOnly_hubFromStdioLike,
} from './mcp-hub-sync';
import type { McpHubConfig } from './mcp-hub-core';
import {
  MCP_MANIFEST_SCHEMA,
  PLUGIN_MANIFEST_SCHEMA,
} from '../orch/agent-plugin-manifest';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-sync-'));
  tempDirs.push(dir);
  return dir;
}

function clineSettingsPath(home: string): string {
  let hostRoot: string;
  if (process.platform === 'darwin') {
    hostRoot = path.join(home, 'Library', 'Application Support', 'Code');
  } else if (process.platform === 'win32') {
    const appData = path.join(home, 'AppData', 'Roaming');
    vi.stubEnv('APPDATA', appData);
    hostRoot = path.join(appData, 'Code');
  } else {
    const xdg = path.join(home, '.config');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    hostRoot = path.join(xdg, 'Code');
  }
  return path.join(
    hostRoot,
    'User',
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );
}

const emptyHub: McpHubConfig = { schemaVersion: 1, servers: [] };

describe('hubFromStdioLike', () => {
  it('aceita stdio e http', () => {
    const a = __testOnly_hubFromStdioLike(
      'Firecrawl',
      { command: 'npx', args: ['-y', 'fc'], env: { KEY: 'x' } },
      'cursor',
    );
    expect(a?.id).toBe('firecrawl');
    expect(a?.transport).toBe('stdio');
    expect(a?.source).toBe('cursor');

    const b = __testOnly_hubFromStdioLike(
      'remote',
      { url: 'https://example.com/mcp' },
      'other',
    );
    expect(b?.transport).toBe('streamable-http');
  });
});

describe('plan + apply fill-gaps', () => {
  beforeEach(() => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.mcpHub, true);
  });

  it('importa observe → hub e espelha gaps → cursor (dryRun)', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          supabase: { command: 'npx', args: ['supabase'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          supabase: { command: 'npx' },
          onlyClaude: { command: 'node', args: ['x.js'] },
        },
      }),
    );

    const observed = collectObservedHubServers(home);
    expect(observed.map((s) => s.id).sort()).toEqual([
      'onlyclaude',
      'supabase',
    ]);

    const plan = planMcpSync({ hub: emptyHub, home });
    expect([...plan.importIds].sort()).toEqual(['onlyclaude', 'supabase']);
    // After virtual import, cursor lacks onlyclaude
    expect(plan.exportByTool.cursor).toContain('onlyclaude');

    const hubPath = path.join(home, 'mcp-hub.json');
    const dry = applyMcpSync({
      hub: emptyHub,
      hubPath,
      home,
      dryRun: true,
      mode: 'both',
    });
    expect(dry.hubWrote).toBe(false);
    expect(fs.existsSync(hubPath)).toBe(false);

    const live = applyMcpSync({
      hub: emptyHub,
      hubPath,
      home,
      dryRun: false,
      mode: 'both',
    });
    expect(live.hubWrote).toBe(true);
    const hubWritten = JSON.parse(fs.readFileSync(hubPath, 'utf8')) as McpHubConfig;
    expect(hubWritten.servers.map((s) => s.id).sort()).toEqual([
      'onlyclaude',
      'supabase',
    ]);

    const cursor = JSON.parse(
      fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursor.mcpServers.onlyclaude).toBeTruthy();
    expect(cursor.mcpServers.supabase).toBeTruthy();
  });

  it('imports a validated plugin MCP only on explicit sync and never auto-approves it', () => {
    const home = tmpHome();
    const pluginRoot = path.join(home, '.nexus', 'plugins', 'acme-tools');
    const sentinel = path.join(home, 'server-executed');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        $schema: PLUGIN_MANIFEST_SCHEMA,
        name: 'acme-tools',
        version: '1.0.0',
        description: 'Acme tools',
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'mcp.json'),
      JSON.stringify({
        $schema: MCP_MANIFEST_SCHEMA,
        mcpServers: {
          files: {
            type: 'stdio',
            command: './server.sh',
            args: ['--safe'],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'server.sh'),
      `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`,
      { mode: 0o700 },
    );
    const clinePath = clineSettingsPath(home);
    const clineDir = path.dirname(clinePath);
    fs.mkdirSync(clineDir, { recursive: true });
    fs.writeFileSync(clinePath, JSON.stringify({ mcpServers: {} }));

    const observed = collectObservedHubServers(home);
    const plan = planMcpSync({ hub: emptyHub, home });

    expect(observed).toContainEqual(
      expect.objectContaining({
        id: 'agent-plugin-acme-tools-files',
        source: 'other',
        transport: 'stdio',
      }),
    );
    expect(plan.importIds).toContain('agent-plugin-acme-tools-files');
    expect(fs.existsSync(sentinel)).toBe(false);

    const hubPath = path.join(home, 'mcp-hub.json');
    const result = applyMcpSync({
      hub: emptyHub,
      hubPath,
      home,
      mode: 'both',
      exportTools: ['cline'],
    });
    const hub = JSON.parse(fs.readFileSync(hubPath, 'utf8')) as McpHubConfig;
    const cline = JSON.parse(fs.readFileSync(clinePath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(result.hubWrote).toBe(true);
    expect(hub.servers).toContainEqual(
      expect.objectContaining({
        id: 'agent-plugin-acme-tools-files',
        cwd: fs.realpathSync(pluginRoot),
      }),
    );
    expect(cline.mcpServers['agent-plugin-acme-tools-files']).toMatchObject({
      disabled: false,
      autoApprove: [],
    });
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('exportTools opt-in só escreve nas tools escolhidas', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: {} }),
    );
    fs.writeFileSync(
      path.join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: {} }),
    );
    const hubPath = path.join(home, 'hub.json');
    const hub: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'only-here',
          name: 'only-here',
          transport: 'stdio',
          command: 'npx',
          tools: [],
          source: 'nexus',
        },
      ],
    };
    applyMcpSync({
      hub,
      hubPath,
      home,
      mode: 'export',
      exportTools: ['cursor'],
    });
    const cursor = JSON.parse(
      fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    const opencode = JSON.parse(
      fs.readFileSync(
        path.join(home, '.config', 'opencode', 'opencode.json'),
        'utf8',
      ),
    ) as { mcp: Record<string, unknown> };
    expect(cursor.mcpServers['only-here']).toBeTruthy();
    expect(opencode.mcp['only-here']).toBeUndefined();
  });

  it('recusa exportar quando a config da tool existe mas não pôde ser lida', () => {
    // Config grande demais para o leitor: antes ela era tratada como "vazia" e
    // o export escrevia um arquivo novo POR CIMA dela — sem backup, porque não
    // havia conteúdo lido para salvar. Aqui ela tem que sair intacta.
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const cursorPath = path.join(home, '.cursor', 'mcp.json');
    const oversized = JSON.stringify({
      mcpServers: { firecrawl: { command: 'npx' } },
      pad: 'x'.repeat(2_000_001),
    });
    fs.writeFileSync(cursorPath, oversized);
    const hub: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'only-here',
          name: 'only-here',
          transport: 'stdio',
          command: 'npx',
          tools: [],
          source: 'nexus',
        },
      ],
    };

    applyMcpSync({
      hub,
      hubPath: path.join(home, 'hub.json'),
      home,
      mode: 'export',
      exportTools: ['cursor'],
    });

    expect(fs.readFileSync(cursorPath, 'utf8')).toBe(oversized);
    expect(
      fs.readdirSync(path.join(home, '.cursor')).filter((f) => f !== 'mcp.json'),
    ).toEqual([]);
  });

  it('não apaga servers existentes na tool', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          keepme: { command: 'echo' },
        },
      }),
    );
    const hubPath = path.join(home, 'hub.json');
    const hub: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'newone',
          name: 'newone',
          transport: 'stdio',
          command: 'npx',
          tools: [],
          source: 'nexus',
        },
      ],
    };
    applyMcpSync({ hub, hubPath, home, mode: 'export' });
    const cursor = JSON.parse(
      fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursor.mcpServers.keepme).toBeTruthy();
    expect(cursor.mcpServers.newone).toBeTruthy();
  });

  it('export fill-gaps → Cline (mcpServers + disabled/autoApprove)', () => {
    const home = tmpHome();
    const clinePath = clineSettingsPath(home);
    const clineDir = path.dirname(clinePath);
    fs.mkdirSync(clineDir, { recursive: true });
    fs.writeFileSync(
      clinePath,
      JSON.stringify({
        mcpServers: {
          keepme: { command: 'echo', disabled: false, autoApprove: [] },
        },
      }),
    );
    const hubPath = path.join(home, 'hub.json');
    const hub: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'from-hub',
          name: 'from-hub',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'demo'],
          tools: [],
          source: 'nexus',
        },
      ],
    };
    const plan = planMcpSync({ hub, home });
    expect(plan.exportByTool.cline).toContain('from-hub');
    expect(plan.skipped.join(' ')).not.toMatch(/cline/);

    const result = applyMcpSync({
      hub,
      hubPath,
      home,
      mode: 'export',
      exportTools: ['cline'],
    });
    expect(result.toolWrites.some((w) => w.tool === 'cline')).toBe(true);
    const written = JSON.parse(fs.readFileSync(clinePath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(written.mcpServers.keepme).toBeTruthy();
    expect(written.mcpServers['from-hub']).toMatchObject({
      command: 'npx',
      args: ['-y', 'demo'],
      disabled: false,
      autoApprove: [],
    });
    // Backup next to original
    const bak = fs
      .readdirSync(clineDir)
      .find((f) => f.startsWith('cline_mcp_settings.json.') && f.endsWith('.bak'));
    expect(bak).toBeTruthy();
  });

  it('Cline fail-closed quando settings ausente', () => {
    const home = tmpHome();
    const hub: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'solo',
          name: 'solo',
          transport: 'stdio',
          command: 'npx',
          tools: [],
          source: 'nexus',
        },
      ],
    };
    const plan = planMcpSync({ hub, home });
    expect(plan.exportByTool.cline).toBeUndefined();
    expect(plan.skipped).toContain('cline: config missing');

    const hubPath = path.join(home, 'hub.json');
    const result = applyMcpSync({
      hub,
      hubPath,
      home,
      mode: 'export',
      exportTools: ['cline'],
    });
    expect(result.toolWrites).toEqual([]);
    const ghost = clineSettingsPath(home);
    expect(fs.existsSync(ghost)).toBe(false);
  });
});
