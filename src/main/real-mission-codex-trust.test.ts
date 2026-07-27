import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';

import {
  stageRealMissionCodexTrust,
  trustRealMissionCodexProjectPath,
} from './real-mission-codex-trust';

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
  it('registers disposable scratch + worktree roots as untrusted', () => {
    const userData = makeUserData();
    const workspace = path.join(userData, 'real-mission-workspace-test');
    fs.mkdirSync(workspace, { mode: 0o700 });

    const configPath = stageRealMissionCodexTrust(userData, workspace);
    const config = parse(fs.readFileSync(configPath, 'utf8')) as {
      features?: {
        apps?: boolean;
        plugins?: boolean;
        remote_plugin?: boolean;
      };
      projects?: Record<string, { trust_level?: string }>;
    };
    const canonicalUserData = fs.realpathSync(userData);
    const canonicalWorkspace = fs.realpathSync(workspace);
    const projectRuntime = path.join(canonicalUserData, 'project-runtime');

    expect(config.projects?.[canonicalUserData]?.trust_level).toBe('untrusted');
    expect(config.projects?.[canonicalWorkspace]?.trust_level).toBe(
      'untrusted',
    );
    expect(config.projects?.[projectRuntime]?.trust_level).toBe('untrusted');
    expect(config.features).toEqual({
      apps: false,
      hooks: true,
      multi_agent: false,
      plugins: false,
      remote_plugin: false,
    });
    expect(Object.keys(config.projects ?? {}).sort()).toEqual(
      [canonicalUserData, canonicalWorkspace, projectRuntime].sort(),
    );
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

  it('no-ops worktree trust outside the real-mission process flag', () => {
    // isCurrentProcessRealMissionE2E is fixed at module load from process.argv.
    // Vitest runs without the flag, so append must be a silent no-op here.
    const userData = makeUserData();
    const workspace = path.join(userData, 'real-mission-workspace-test');
    fs.mkdirSync(workspace, { mode: 0o700 });
    stageRealMissionCodexTrust(userData, workspace);
    const worktree = path.join(userData, 'project-runtime', 'worktrees', 'task-1');
    fs.mkdirSync(worktree, { recursive: true, mode: 0o700 });
    const before = fs.readFileSync(
      path.join(userData, 'home', '.codex', 'config.toml'),
      'utf8',
    );
    trustRealMissionCodexProjectPath(userData, worktree);
    const after = fs.readFileSync(
      path.join(userData, 'home', '.codex', 'config.toml'),
      'utf8',
    );
    expect(after).toBe(before);
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
