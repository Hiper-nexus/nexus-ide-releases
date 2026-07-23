import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';

import { stageRealMissionCodexTrust } from './real-mission-codex-trust';

const temporaryDirectories: string[] = [];

function makeUserData(): string {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-real-mission-trust-'),
  );
  temporaryDirectories.push(userData);
  fs.mkdirSync(path.join(userData, 'home', '.codex'), {
    recursive: true,
    mode: 0o700,
  });
  return userData;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('real mission Codex trust fixture', () => {
  it('trusts only the canonical disposable workspace with private config', () => {
    const userData = makeUserData();
    const workspace = path.join(userData, 'real-mission-workspace-test');
    fs.mkdirSync(workspace, { mode: 0o700 });

    const configPath = stageRealMissionCodexTrust(userData, workspace);
    const config = parse(fs.readFileSync(configPath, 'utf8')) as {
      projects?: Record<string, { trust_level?: string }>;
    };
    const canonicalWorkspace = fs.realpathSync(workspace);

    expect(config.projects?.[canonicalWorkspace]?.trust_level).toBe('trusted');
    expect(Object.keys(config.projects ?? {})).toEqual([canonicalWorkspace]);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('rejects a workspace outside the disposable user-data root', () => {
    const userData = makeUserData();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-real-mission-outside-'),
    );
    temporaryDirectories.push(outside);

    expect(() => stageRealMissionCodexTrust(userData, outside)).toThrow(
      /outside disposable user data/,
    );
  });

  it('never overwrites a pre-existing Codex config', () => {
    const userData = makeUserData();
    const workspace = path.join(userData, 'real-mission-workspace-test');
    const configPath = path.join(userData, 'home', '.codex', 'config.toml');
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.writeFileSync(configPath, 'model = "existing"\n', { mode: 0o600 });

    expect(() => stageRealMissionCodexTrust(userData, workspace)).toThrow(
      /already exists/,
    );
    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "existing"\n');
  });
});
