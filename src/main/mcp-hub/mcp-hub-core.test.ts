import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  detectDrift,
  isMaskedSecretValue,
  maskServerForUi,
  restoreMaskedSecrets,
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
  it('does not follow a pre-planted predictable temp-file symlink', () => {
    enableHub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-tmp-link-'));
    dirs.push(dir);
    const outside = path.join(dir, 'outside.txt');
    const file = path.join(dir, 'mcp.json');
    const predictableTemp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(outside, 'DO NOT REPLACE');
    fs.symlinkSync(outside, predictableTemp);

    writeConfigWithBackup(file, { schemaVersion: 1, servers: [] });

    expect(fs.readFileSync(outside, 'utf8')).toBe('DO NOT REPLACE');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      servers: [],
    });
  });

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

  it('masks vault refs as full redaction (never partial prefix leak)', () => {
    const masked = maskServerForUi({
      id: 's1',
      name: 'S',
      transport: 'stdio',
      tools: ['t'],
      source: 'nexus',
      env: {
        API_TOKEN: '__nexus_vault__:mcphub:scope:s1:env:API_TOKEN',
        PATH: '/usr/bin',
      },
      headers: {
        Authorization: '__nexus_vault__:mcphub:scope:s1:headers:Authorization',
      },
    });
    expect(masked.env?.API_TOKEN).toBe('[REDACTED]');
    expect(masked.env?.PATH).toBe('/usr/bin');
    expect(masked.headers?.Authorization).toBe('[REDACTED]');
    // Partial mask would leak the vault prefix and break restore.
    expect(masked.env?.API_TOKEN).not.toMatch(/^__/);
  });

  it('F-1383: masks args that hold a vault ref or were resolved from one', () => {
    const masked = maskServerForUi(
      {
        id: 'figma',
        name: 'Figma',
        transport: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'figma-mcp',
          `--figma-api-key=figd_${'X'.repeat(56)}`,
        ],
        tools: [],
        source: 'claude-code',
      },
      new Set(['args.2']),
    );
    expect(masked.args).toEqual(['-y', 'figma-mcp', '[REDACTED]']);
    expect(JSON.stringify(masked)).not.toContain('figd_');

    const withRef = maskServerForUi({
      id: 'figma',
      name: 'Figma',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '__nexus_vault__:mcphub:scope:figma:args:1'],
      tools: [],
      source: 'claude-code',
    });
    expect(withRef.args?.[1]).toBe('[REDACTED]');
    expect(JSON.stringify(withRef)).not.toContain('__nexus_vault__');
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

  it('can skip .bak when rewriting sealed vault migration (no plaintext re-persist)', () => {
    enableHub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-hub-nobak-'));
    dirs.push(dir);
    const file = path.join(dir, 'mcp.json');
    const plaintext: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'n',
          name: 'N',
          transport: 'stdio',
          command: 'echo',
          tools: [],
          source: 'nexus',
          env: { API_KEY: 'sk-live-must-not-land-in-bak' },
        },
      ],
    };
    writeConfigWithBackup(file, plaintext);
    const sealed: McpHubConfig = {
      ...plaintext,
      servers: [
        {
          ...plaintext.servers[0]!,
          env: {
            API_KEY: '__nexus_vault__:mcphub:scope:n:env:API_KEY',
          },
        },
      ],
    };
    const { backupPath, wrote } = writeConfigWithBackup(file, sealed, {
      backup: false,
    });
    expect(wrote).toBe(true);
    expect(backupPath).toBeNull();
    const siblings = fs.readdirSync(dir);
    expect(siblings.filter((name) => name.endsWith('.bak'))).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(
      'sk-live-must-not-land-in-bak',
    );
  });

  it('F-1364: N saves seguidos deixam no máximo 1 backup timestamped, e ele ainda faz rollback', () => {
    enableHub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-hub-prune-'));
    dirs.push(dir);
    const file = path.join(dir, 'mcp.json');
    const mk = (name: string): McpHubConfig => ({
      schemaVersion: 1,
      servers: [
        {
          id: 'n',
          name,
          transport: 'stdio',
          command: 'echo',
          tools: [],
          source: 'nexus',
        },
      ],
    });
    writeConfigWithBackup(file, mk('N1'));
    writeConfigWithBackup(file, mk('N2'));
    const { backupPath } = writeConfigWithBackup(file, mk('N3'));
    const baks = fs
      .readdirSync(dir)
      .filter((name) => /^mcp\.json\.\d+\.[0-9a-f]{16}\.bak$/.test(name));
    expect(baks.length).toBeLessThanOrEqual(1);
    // O bak sobrevivente é o penúltimo conteúdo (N2) e continua rolável.
    expect(backupPath).toBeTruthy();
    rollbackFromBackup(file, backupPath!);
    const restored = JSON.parse(fs.readFileSync(file, 'utf8')) as McpHubConfig;
    expect(restored.servers[0]?.name).toBe('N2');
  });

  it('F-1364: o .gitignore do repositório cobre o backup timestamped do hub', () => {
    // O bak carrega argv/env com segredo: ficar untracked no checkout é o
    // vazamento (git add -A). Ele tem que casar uma linha do .gitignore.
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const lines = fs
      .readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const victim = '.nexus/mcp-hub.json.1791722976651.e6e60192c6c00a44.bak';
    const matches = (rawPattern: string): boolean => {
      // Glob mínimo do gitignore: '/' inicial ancora na raiz (equivalente a
      // caminho relativo da raiz), '*' é [^/]*.
      const pattern = rawPattern.replace(/^\//, '');
      const re = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
      );
      return re.test(victim);
    };
    expect(lines.some(matches)).toBe(true);
  });

  it('does not follow a destination symlink during rollback', () => {
    enableHub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-rb-link-'));
    dirs.push(dir);
    const outside = path.join(dir, 'outside.json');
    const file = path.join(dir, 'mcp.json');
    const backup = path.join(dir, 'mcp.json.safe.bak');
    fs.writeFileSync(outside, 'DO NOT REPLACE');
    fs.writeFileSync(backup, '{"schemaVersion":1,"servers":[]}');
    fs.symlinkSync(outside, file);

    expect(() => rollbackFromBackup(file, backup)).toThrow(/regular file/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('DO NOT REPLACE');
  });
});

describe('restoreMaskedSecrets', () => {
  const stored: McpHubConfig = {
    schemaVersion: 1,
    servers: [
      {
        id: 's1',
        name: 'Server',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { authorization: 'Bearer real-token-value' },
        env: { API_KEY: 'sk-real-1234567890', REGION: 'us-east-1' },
        tools: [],
        source: 'nexus',
      },
    ],
  };

  it('detects masked placeholder shapes', () => {
    expect(isMaskedSecretValue('[REDACTED]')).toBe(true);
    expect(isMaskedSecretValue('sk…[REDACTED]')).toBe(true);
    expect(isMaskedSecretValue('sk-real-1234567890')).toBe(false);
  });

  it('round-trip of a masked load keeps the stored secrets', () => {
    const masked: McpHubConfig = {
      schemaVersion: 1,
      servers: stored.servers.map((server) => maskServerForUi(server)),
    };
    const restored = restoreMaskedSecrets(masked, stored);
    expect(restored.servers[0]?.headers?.authorization).toBe(
      'Bearer real-token-value',
    );
    expect(restored.servers[0]?.env?.API_KEY).toBe('sk-real-1234567890');
    // Non-secret values pass through untouched.
    expect(restored.servers[0]?.env?.REGION).toBe('us-east-1');
  });

  it('F-1383 (revisão Fable): arg removido com placeholders recusa o save em vez de trocar valores', () => {
    const stored: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'x',
          name: 'X',
          transport: 'stdio',
          command: 'npx',
          args: ['--verbose', 'sk-A-1234567890abcdef', '--token', 'sk-B-1234567890abcdef'],
          tools: [],
          source: 'nexus',
        },
      ],
    };
    // UI mostrou ['--verbose','[REDACTED]','--token','[REDACTED]']; o operador tirou '--verbose'.
    const edited: McpHubConfig = {
      schemaVersion: 1,
      servers: [{ ...stored.servers[0]!, args: ['[REDACTED]', '--token', '[REDACTED]'] }],
    };
    expect(() => restoreMaskedSecrets(edited, stored)).toThrow(/x\.args\.\d+ cannot be matched/);
    // Mesmo comprimento, vizinho trocado: também recusa.
    const reordered: McpHubConfig = {
      schemaVersion: 1,
      servers: [{ ...stored.servers[0]!, args: ['--token', '[REDACTED]', '--verbose', '[REDACTED]'] }],
    };
    expect(() => restoreMaskedSecrets(reordered, stored)).toThrow(/cannot be matched/);
    // Lista intacta continua restaurando por posição.
    const same: McpHubConfig = {
      schemaVersion: 1,
      servers: [{ ...stored.servers[0]!, args: ['--verbose', '[REDACTED]', '--token', '[REDACTED]'] }],
    };
    expect(restoreMaskedSecrets(same, stored).servers[0]?.args).toEqual(stored.servers[0]?.args);
  });

  it('F-1383: restores a masked arg from the stored config by index', () => {
    const storedWithArgs: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'figma',
          name: 'Figma',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'figma-mcp', '__nexus_vault__:mcphub:scope:figma:args:2'],
          tools: [],
          source: 'claude-code',
        },
      ],
    };
    const masked: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          ...storedWithArgs.servers[0]!,
          args: ['-y', 'figma-mcp', '[REDACTED]'],
        },
      ],
    };
    const restored = restoreMaskedSecrets(masked, storedWithArgs);
    expect(restored.servers[0]?.args?.[2]).toBe(
      '__nexus_vault__:mcphub:scope:figma:args:2',
    );
    // Masked arg without a stored counterpart is rejected (fail-closed).
    expect(() =>
      restoreMaskedSecrets(masked, {
        schemaVersion: 1,
        servers: [{ ...storedWithArgs.servers[0]!, args: ['-y'] }],
      }),
    ).toThrow(/masked secret/i);
  });

  it('accepts a new real secret value as-is', () => {
    const next: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          ...stored.servers[0],
          env: { API_KEY: 'sk-rotated-0987654321', REGION: 'us-east-1' },
        },
      ],
    };
    const restored = restoreMaskedSecrets(next, stored);
    expect(restored.servers[0]?.env?.API_KEY).toBe('sk-rotated-0987654321');
  });

  it('fails closed when a masked value has no stored counterpart', () => {
    const orphan: McpHubConfig = {
      schemaVersion: 1,
      servers: [
        {
          id: 'brand-new',
          name: 'New',
          transport: 'stdio',
          command: 'run',
          env: { TOKEN: '[REDACTED]' },
          tools: [],
          source: 'nexus',
        },
      ],
    };
    expect(() => restoreMaskedSecrets(orphan, stored)).toThrow(/re-enter/i);
  });
});
