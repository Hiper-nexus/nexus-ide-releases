import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  detectDrift,
  maskServerForUi,
  rollbackFromBackup,
  toolMatrix,
  writeConfigWithBackup,
  type McpHubConfig,
} from './mcp-hub-core';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function enableHub(): void {
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.mcpHub, true);
}

describe('mcp hub core', () => {
  it('refuses to read an existing config symlink before replacing it', () => {
    enableHub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-link-'));
    dirs.push(dir);
    const outside = path.join(dir, 'outside.json');
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(outside, '{"secret":"outside"}');
    fs.symlinkSync(outside, file);

    expect(() =>
      writeConfigWithBackup(file, { schemaVersion: 1, servers: [] }),
    ).toThrow(/regular file/i);
  });

  it('masks secrets in UI projection', () => {
    const masked = maskServerForUi({
      id: 's1',
      name: 'S',
      transport: 'stdio',
      tools: ['t'],
      source: 'nexus',
      env: { API_TOKEN: 'super-secret-value', PATH: '/usr/bin' },
      headers: { Authorization: 'Bearer xyz' },
    });
    expect(masked.env?.API_TOKEN).toContain('REDACTED');
    expect(masked.env?.PATH).toBe('/usr/bin');
    expect(masked.headers?.Authorization).toContain('REDACTED');
  });

  it('detects drift and builds tool matrix', () => {
    const a: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'a',
          name: 'A',
          transport: 'stdio',
          tools: ['x', 'y'],
          source: 'claude-code',
        },
      ],
    };
    const b: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'a',
          name: 'A2',
          transport: 'stdio',
          tools: ['x'],
          source: 'claude-code',
        },
        {
          id: 'b',
          name: 'B',
          transport: 'streamable-http',
          url: 'https://example.invalid',
          tools: ['z'],
          source: 'cursor',
        },
      ],
    };
    const drift = detectDrift(a, b);
    expect(drift.drifted).toBe(true);
    expect(drift.added).toContain('b');
    expect(drift.changed).toContain('a');
    expect(toolMatrix(b).length).toBe(2);
  });

  it('writes with backup and rolls back', () => {
    enableHub();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-hub-'));
    dirs.push(dir);
    const file = path.join(dir, 'mcp.json');
    const cfg: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'n',
          name: 'N',
          transport: 'stdio',
          command: 'echo',
          tools: [],
          source: 'nexus',
        },
      ],
    };
    writeConfigWithBackup(file, cfg);
    const next = {
      ...cfg,
      servers: [{ ...cfg.servers[0], name: 'N2', tools: ['t1'] }],
    };
    const { backupPath, wrote } = writeConfigWithBackup(file, next);
    expect(wrote).toBe(true);
    expect(backupPath).toBeTruthy();
    rollbackFromBackup(file, backupPath!);
    const restored = JSON.parse(fs.readFileSync(file, 'utf8')) as McpHubConfig;
    expect(restored.servers[0]?.name).toBe('N');
  });
});
