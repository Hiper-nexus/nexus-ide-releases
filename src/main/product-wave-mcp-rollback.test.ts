import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
import { getFeatureFlagRegistry } from './feature-flags/feature-flag-registry';
import {
  mcpHubConfigSchema,
  rollbackFromBackup,
  writeConfigWithBackup,
} from './mcp-hub/mcp-hub-core';
import { assertWorkspaceMcpHubBackup } from './product-wave-ipc';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('product MCP hub rollback path', () => {
  it('save → .bak → assertWorkspaceMcpHubBackup → rollback restores prior config', () => {
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.mcpHub, true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-rb-'));
    dirs.push(root);
    const nexus = path.join(root, '.nexus');
    fs.mkdirSync(nexus, { recursive: true, mode: 0o700 });
    const hubPath = path.join(nexus, 'mcp-hub.json');

    const v1 = mcpHubConfigSchema.parse({
      schemaVersion: 1,
      servers: [
        {
          id: 's1',
          name: 'One',
          transport: 'stdio',
          command: 'echo',
          tools: [],
          source: 'nexus',
        },
      ],
    });
    writeConfigWithBackup(hubPath, v1);
    const v2 = {
      ...v1,
      servers: [{ ...v1.servers[0], name: 'Two', tools: ['t1'] }],
    };
    const { backupPath, wrote } = writeConfigWithBackup(hubPath, v2);
    expect(wrote).toBe(true);
    expect(backupPath).toBeTruthy();

    // Product path: only workspace .nexus/*.bak accepted.
    const allowed = assertWorkspaceMcpHubBackup(root, backupPath!);
    expect(allowed).toBe(fs.realpathSync(backupPath!));

    // Outside path rejected.
    const outside = path.join(os.tmpdir(), `evil-${Date.now()}.bak`);
    fs.writeFileSync(outside, '{}');
    dirs.push(outside);
    expect(() => assertWorkspaceMcpHubBackup(root, outside)).toThrow(
      /invalid backup path/,
    );
    expect(() =>
      assertWorkspaceMcpHubBackup(root, path.join(root, '..', 'x.bak')),
    ).toThrow();

    rollbackFromBackup(hubPath, allowed);
    const restored = mcpHubConfigSchema.parse(
      JSON.parse(fs.readFileSync(hubPath, 'utf8')),
    );
    expect(restored.servers[0]?.name).toBe('One');
    expect(restored.servers[0]?.tools).toEqual([]);
  });
});
