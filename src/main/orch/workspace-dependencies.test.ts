import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatWorkspaceDependencies,
  resolveWorkspaceDependencies,
} from './workspace-dependencies';
import { buildWorkspaceDependencyTools } from './tools-workspace-dependencies';
import { isToolAllowed } from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';

const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-workspace-deps-'));
  sandboxes.push(dir);
  return dir;
}

function executable(file: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
}

afterEach(() => {
  sandboxes.splice(0).forEach((dir) =>
    rmSync(dir, { recursive: true, force: true }),
  );
});

describe('workspace dependency bridge', () => {
  it('discovers the Codex Desktop runtime and returns its exact Python', async () => {
    const home = sandbox();
    const root = join(
      home,
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
    );
    const python = join(root, 'python', 'bin', 'python3');
    executable(python);
    executable(join(root, 'node', 'bin', 'node'));
    executable(join(root, 'bin', 'fallback', 'git'));
    executable(join(root, 'bin', 'fallback', 'pnpm'));

    const result = await resolveWorkspaceDependencies({
      home,
      env: {},
      verifyPython: (candidate) => candidate === python,
    });

    expect(result).toMatchObject({
      source: 'codex-runtime',
      root,
      python,
      pythonPackages: join(root, 'python'),
      node: join(root, 'node', 'bin', 'node'),
      git: join(root, 'bin', 'fallback', 'git'),
      pnpm: join(root, 'bin', 'fallback', 'pnpm'),
    });
    expect(formatWorkspaceDependencies(result)).toContain(
      `Python executable: \`${python}\``,
    );
  });

  it('falls back to a PATH Python only when Pillow is usable', async () => {
    const home = sandbox();
    const bin = join(home, 'bin');
    const python = join(bin, 'python3');
    executable(python);

    const result = await resolveWorkspaceDependencies({
      home,
      env: { PATH: [bin, '/missing'].join(delimiter) },
      verifyPython: (candidate) => candidate === python,
    });

    expect(result).toEqual({ source: 'system-python', python });
  });

  it('fails clearly when neither bundled nor Pillow-capable Python exists', async () => {
    const home = sandbox();
    await expect(
      resolveWorkspaceDependencies({
        home,
        env: { PATH: '' },
        verifyPython: () => false,
      }),
    ).rejects.toThrow(/runtime de dependências.*não foi encontrado/i);
  });

  it('awaits the Pillow probe without blocking another main-loop task', async () => {
    const home = sandbox();
    const python = join(home, 'python3');
    executable(python);
    let releaseProbe: ((value: boolean) => void) | undefined;
    const probe = new Promise<boolean>((resolve) => {
      releaseProbe = resolve;
    });
    const pending = resolveWorkspaceDependencies({
      home,
      env: { NEXUS_WORKSPACE_PYTHON: python, PATH: '' },
      verifyPython: () => probe,
    });
    const loopTurn = await new Promise<string>((resolve) =>
      setImmediate(() => resolve('free')),
    );

    expect(loopTurn).toBe('free');
    releaseProbe?.(true);
    await expect(pending).resolves.toEqual({
      source: 'system-python',
      python,
    });
  });

  it('publishes the Desktop-compatible tool name to MCP agents', async () => {
    const home = sandbox();
    const python = join(home, 'python3');
    executable(python);
    const [tool] = buildWorkspaceDependencyTools(() => ({
      source: 'system-python',
      python,
    }));

    expect(tool.name).toBe('load_workspace_dependencies');
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    expect(isToolAllowed(['load_workspace_dependencies'], tool.name)).toBe(true);
    expect(isToolAllowed([], tool.name)).toBe(false);
    expect(effectPolicyForTool(tool.name)).toBe('read-only');
    await expect(tool.handler({}, {} as never)).resolves.toContain(
      `Python executable: \`${python}\``,
    );
  });
});
