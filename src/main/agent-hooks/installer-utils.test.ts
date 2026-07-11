import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHooksJson } from './installer-utils';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('writeHooksJson permissions', () => {
  it('creates the config with private permissions', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.claude', 'settings.json');

    writeHooksJson(configPath, { hooks: {} });

    expect(modeOf(configPath)).toBe(0o600);
  });

  it('preserves a more restrictive existing mode for config and backup', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.claude', 'settings.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(configPath, '{"hooks":{}}\n');
    chmodSync(configPath, 0o400);

    writeHooksJson(configPath, { hooks: { Stop: [] } });

    expect(modeOf(configPath)).toBe(0o400);
    expect(modeOf(`${configPath}.bak`)).toBe(0o400);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('{"hooks":{}}\n');
  });

  it('tightens a permissive existing mode for config and backup', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.codex', 'hooks.json');
    mkdirSync(join(root, '.codex'));
    writeFileSync(configPath, '{"hooks":{}}\n');
    chmodSync(configPath, 0o644);

    writeHooksJson(configPath, { hooks: { Stop: [] } });

    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(`${configPath}.bak`)).toBe(0o600);
  });

  it('tightens an unchanged config and an existing backup', () => {
    root = mkdtempSync(join(tmpdir(), 'nexus-hooks-mode-'));
    const configPath = join(root, '.claude', 'settings.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(configPath, '{\n  "hooks": {}\n}\n');
    writeFileSync(`${configPath}.bak`, 'private backup\n');
    chmodSync(configPath, 0o644);
    chmodSync(`${configPath}.bak`, 0o400);

    writeHooksJson(configPath, { hooks: {} });

    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(`${configPath}.bak`)).toBe(0o400);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('private backup\n');
  });
});
