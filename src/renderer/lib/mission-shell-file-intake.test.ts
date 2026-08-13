/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  partitionDroppedMissionFiles,
  resolveDroppedMissionContextPath,
  shellClaimsMissionFileDrop,
} from './mission-shell-file-intake';

function file(name: string, type: string): File {
  return new File(['bytes'], name, { type });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shellClaimsMissionFileDrop', () => {
  it('only the launcher and the setup wizard claim a shell file drop', () => {
    expect(shellClaimsMissionFileDrop('launcher')).toBe(true);
    expect(shellClaimsMissionFileDrop('mission-setup')).toBe(true);
    expect(shellClaimsMissionFileDrop('terminal')).toBe(false);
    expect(shellClaimsMissionFileDrop('mission')).toBe(false);
    expect(shellClaimsMissionFileDrop('project')).toBe(false);
    expect(shellClaimsMissionFileDrop('task-board')).toBe(false);
    expect(shellClaimsMissionFileDrop('settings')).toBe(false);
  });
});

describe('partitionDroppedMissionFiles', () => {
  it('keeps in-project files as context and stages external audio/image/text', () => {
    const pathForFile = vi.fn((candidate: File) => {
      if (candidate.name === 'src.ts') return '/workspace/src/app.ts';
      return '/Users/me/Desktop/cliente.m4a';
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { files: { pathForFile } },
    });

    const split = partitionDroppedMissionFiles('/workspace', [
      file('src.ts', 'text/plain'),
      file('cliente.m4a', 'audio/mp4'),
      file('virus.exe', 'application/x-msdownload'),
    ]);

    expect(split.inProject).toEqual(['src/app.ts']);
    expect(split.toImport.map((item) => item.name)).toEqual(['cliente.m4a']);
    expect(split.rejected.map((item) => item.name)).toEqual(['virus.exe']);
  });
});

describe('resolveDroppedMissionContextPath', () => {
  it('returns a relative path for files already in the workspace', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/workspace/src/app.ts',
          importMissionAttachment: vi.fn(),
        },
      },
    });

    await expect(
      resolveDroppedMissionContextPath('/workspace', file('app.ts', 'text/plain')),
    ).resolves.toBe('src/app.ts');
    expect(window.nexus.files.importMissionAttachment).not.toHaveBeenCalled();
  });

  it('copies external audio into .nexus/attachments/mission-context/', async () => {
    const importMissionAttachment = vi.fn(async (name: string) => ({
      ok: true as const,
      path: `.nexus/attachments/mission-context/token-${name}`,
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/Users/me/Desktop/cliente.m4a',
          importMissionAttachment,
        },
      },
    });

    await expect(
      resolveDroppedMissionContextPath(
        '/workspace',
        file('cliente.m4a', 'audio/mp4'),
      ),
    ).resolves.toBe('.nexus/attachments/mission-context/token-cliente.m4a');
    expect(importMissionAttachment).toHaveBeenCalledTimes(1);
  });

  it('does not import unsupported binaries', async () => {
    const importMissionAttachment = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        files: {
          pathForFile: () => '/Users/me/Desktop/virus.exe',
          importMissionAttachment,
        },
      },
    });

    await expect(
      resolveDroppedMissionContextPath(
        '/workspace',
        file('virus.exe', 'application/x-msdownload'),
      ),
    ).resolves.toBeNull();
    expect(importMissionAttachment).not.toHaveBeenCalled();
  });
});
