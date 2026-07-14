import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  observeAcrossTools,
  parseCodexMcpToml,
  parseMcpServersJson,
  parseOpenCodeMcpJson,
  resolveClineMcpSettingsPath,
} from './mcp-hub-observers';
import { normalizeMcpServerKey } from '../../shared/mcp-across-tools';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-obs-'));
  tempDirs.push(dir);
  return dir;
}

describe('mcp parsers', () => {
  it('parseMcpServersJson lê cursor/claude shape', () => {
    const { keys } = parseMcpServersJson(
      JSON.stringify({
        mcpServers: { Firecrawl: { command: 'npx' }, supabase: {} },
      }),
    );
    expect(keys.sort()).toEqual(['firecrawl', 'supabase']);
  });

  it('parseOpenCodeMcpJson lê mcp block', () => {
    const { keys } = parseOpenCodeMcpJson(
      JSON.stringify({ mcp: { bridgememory: { type: 'local' } } }),
    );
    expect(keys).toEqual(['bridgememory']);
  });

  it('parseCodexMcpToml ignora subtables .env', () => {
    const { keys } = parseCodexMcpToml(`
[mcp_servers.supabase]
command = "npx"
[mcp_servers.supabase.env]
TOKEN = "x"
[mcp_servers.firecrawl]
command = "npx"
`);
    expect(keys.sort()).toEqual(['firecrawl', 'supabase']);
  });

  it('normalizeMcpServerKey alinha casing', () => {
    expect(normalizeMcpServerKey('TestSprite')).toBe('testsprite');
  });
});

describe('observeAcrossTools', () => {
  it('marca present/absent/unknown com dados reais de fixture', () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: { supabase: { command: 'npx' }, onlyCursor: {} },
      }),
    );
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { supabase: { command: 'npx' }, onlyClaude: {} },
      }),
    );

    const report = observeAcrossTools({
      home,
      hubServerIds: ['supabase'],
    });

    const supabase = report.rows.find((r) => r.serverKey === 'supabase');
    expect(supabase?.cells.nexus).toBe('present');
    expect(supabase?.cells.cursor).toBe('present');
    expect(supabase?.cells['claude-code']).toBe('present');

    const onlyCursor = report.rows.find((r) => r.serverKey === 'onlycursor');
    expect(onlyCursor?.cells.cursor).toBe('present');
    expect(onlyCursor?.cells['claude-code']).toBe('absent');
    expect(onlyCursor?.cells.nexus).toBe('absent');

    expect(report.driftCount).toBeGreaterThan(0);
    expect(report.columns.find((c) => c.id === 'cursor')?.status).toBe('ok');
    expect(report.columns.find((c) => c.id === 'cline')?.status).toBe(
      'missing',
    );
  });

  it('não inventa células quando tool falta', () => {
    const home = tmpHome();
    const report = observeAcrossTools({ home, hubServerIds: [] });
    const cursor = report.columns.find((c) => c.id === 'cursor');
    expect(cursor?.status).toBe('missing');
    expect(report.rows).toHaveLength(0);
  });

  it('Cline resolve host Cursor quando VS Code Code falta', () => {
    const home = tmpHome();
    const cursorCline = path.join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    fs.mkdirSync(path.dirname(cursorCline), { recursive: true });
    fs.writeFileSync(
      cursorCline,
      JSON.stringify({
        mcpServers: { firecrawl: { command: 'npx', disabled: false } },
      }),
    );
    expect(resolveClineMcpSettingsPath(home)).toBe(cursorCline);

    const report = observeAcrossTools({ home, hubServerIds: [] });
    const col = report.columns.find((c) => c.id === 'cline');
    expect(col?.status).toBe('ok');
    expect(col?.path).toBe(cursorCline);
    expect(report.rows.find((r) => r.serverKey === 'firecrawl')?.cells.cline).toBe(
      'present',
    );
  });

  it('Cline resolve host Linux ~/.config/Cursor quando VS Code falta', () => {
    const home = tmpHome();
    const cursorCline = path.join(
      home,
      '.config',
      'Cursor',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    fs.mkdirSync(path.dirname(cursorCline), { recursive: true });
    fs.writeFileSync(
      cursorCline,
      JSON.stringify({
        mcpServers: { linuxcline: { command: 'npx', disabled: false } },
      }),
    );
    expect(resolveClineMcpSettingsPath(home)).toBe(cursorCline);

    const report = observeAcrossTools({ home, hubServerIds: [] });
    expect(report.columns.find((c) => c.id === 'cline')?.status).toBe('ok');
    expect(
      report.rows.find((r) => r.serverKey === 'linuxcline')?.cells.cline,
    ).toBe('present');
  });
});
