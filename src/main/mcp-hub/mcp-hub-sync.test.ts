import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  applyMcpSync,
  collectObservedHubServers,
  planMcpSync,
  __testOnly_hubFromStdioLike,
} from './mcp-hub-sync';
import type { McpHubConfig } from './mcp-hub-core';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-sync-'));
  tempDirs.push(dir);
  return dir;
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
    const clineDir = path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
    );
    fs.mkdirSync(clineDir, { recursive: true });
    const clinePath = path.join(clineDir, 'cline_mcp_settings.json');
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
    const ghost = path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    expect(fs.existsSync(ghost)).toBe(false);
  });
});
