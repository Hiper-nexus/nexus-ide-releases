import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { designKitContentHash } from './design-kit-source';
import {
  GETDESIGN_FALLBACK_BRANDS,
  GETDESIGN_MAX_KIT_BYTES,
  createGetDesignKitSource,
  isValidGetDesignBrand,
  listGetDesignBrands,
  parseGetDesignBrandList,
  resolveNpxCommand,
  type GetDesignCliRunner,
} from './getdesign-cli-source';

let workDir = '';

function workDirFactory(): string {
  return fs.mkdtempSync(path.join(workDir, 'run-'));
}

const RAYCAST = [
  '---',
  'name: Raycast-design-analysis',
  'description: "Dark command-bar surface."',
  '---',
  '',
  '## Colors',
  'canvas: #0d0d0e',
  '',
].join('\n');

/** Writes the requested --out file, the way the real CLI does. */
function runnerWriting(content: string, code = 0) {
  return vi.fn<GetDesignCliRunner>(async ({ args }) => {
    const outIndex = args.indexOf('--out');
    if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], content);
    return { stdout: '', stderr: '', code };
  });
}

beforeEach(() => {
  workDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-getdesign-test-')),
  );
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('isValidGetDesignBrand', () => {
  it('accepts the catalog slug shape', () => {
    for (const brand of ['raycast', 'linear.app', 'bmw-m', 'nintendo-2001', 'x.ai']) {
      expect(isValidGetDesignBrand(brand)).toBe(true);
    }
  });

  it('rejects anything that could leave the argv or the catalog', () => {
    for (const brand of [
      '',
      '-rf',
      '../etc/passwd',
      'raycast;rm -rf /',
      'ray cast',
      'Raycast',
      '$(whoami)',
      'a'.repeat(65),
    ]) {
      expect(isValidGetDesignBrand(brand)).toBe(false);
    }
  });
});

describe('parseGetDesignBrandList', () => {
  it('extracts brands from a decorated CLI listing', () => {
    const stdout = [
      '[1mAvailable brands[0m',
      '  - raycast          Dark command bar',
      '  - linear.app       Minimal dashboard',
      '  * bmw-m',
      '',
      'Usage: npx getdesign add <brand>',
    ].join('\n');

    expect(parseGetDesignBrandList(stdout)).toEqual([
      'raycast',
      'linear.app',
      'bmw-m',
    ]);
  });

  it('returns nothing when no line looks like a brand', () => {
    expect(parseGetDesignBrandList('ERROR: network unreachable\n')).toEqual([]);
  });
});

describe('listGetDesignBrands', () => {
  it('prefers the live CLI listing', async () => {
    const runCli: GetDesignCliRunner = async () => ({
      stdout: 'raycast\nstripe\n',
      stderr: '',
      code: 0,
    });

    const listed = await listGetDesignBrands({ runCli, workDirFactory });

    expect(listed.isFallback).toBe(false);
    expect(listed.brands).toEqual(['raycast', 'stripe']);
  });

  it('falls back to the static roster and says so when the CLI fails', async () => {
    const runCli: GetDesignCliRunner = async () => {
      throw new Error('npx not found');
    };

    const listed = await listGetDesignBrands({ runCli, workDirFactory });

    expect(listed.isFallback).toBe(true);
    expect(listed.detail).toContain('npx not found');
    expect(listed.brands).toBe(GETDESIGN_FALLBACK_BRANDS);
    expect(listed.brands).toContain('raycast');
  });

  it('removes its temporary directory afterwards', async () => {
    const created: string[] = [];
    const runCli: GetDesignCliRunner = async ({ workDir: dir }) => {
      created.push(dir);
      return { stdout: 'raycast\n', stderr: '', code: 0 };
    };

    await listGetDesignBrands({ runCli, workDirFactory });

    expect(created).toHaveLength(1);
    expect(fs.existsSync(created[0])).toBe(false);
  });
});

describe('createGetDesignKitSource', () => {
  it('downloads a kit with a fixed argv and hashes the content', async () => {
    const runCli = runnerWriting(RAYCAST);
    const source = createGetDesignKitSource({ runCli, workDirFactory });

    const kit = await source.getKit('raycast');

    expect(source.sourceId).toBe('getdesign');
    expect(source.isAlwaysAvailable).toBe(false);
    expect(kit.kitId).toBe('raycast');
    expect(kit.title).toBe('Raycast');
    expect(kit.locator).toBe('getdesign:raycast');
    expect(kit.content).toContain('canvas: #0d0d0e');
    expect(kit.contentHash).toBe(designKitContentHash(RAYCAST));

    const call = runCli.mock.calls[0][0];
    expect(call.args[0]).toBe('add');
    expect(call.args[1]).toBe('raycast');
    expect(call.args[2]).toBe('--out');
  });

  it('never lets an unsafe brand reach the process argv', async () => {
    const runCli = runnerWriting(RAYCAST);
    const source = createGetDesignKitSource({ runCli, workDirFactory });

    await expect(source.getKit('raycast; rm -rf /')).rejects.toThrow(
      /brand must match/i,
    );
    await expect(source.getKit('../../etc/passwd')).rejects.toThrow(
      /brand must match/i,
    );
    expect(runCli).not.toHaveBeenCalled();
  });

  it('surfaces a non-zero CLI exit instead of returning a partial kit', async () => {
    const runCli: GetDesignCliRunner = async () => ({
      stdout: '',
      stderr: 'unknown brand',
      code: 1,
    });
    const source = createGetDesignKitSource({ runCli, workDirFactory });

    await expect(source.getKit('nope')).rejects.toThrow(
      /exited with code 1: unknown brand/,
    );
  });

  it('refuses an empty or missing download', async () => {
    const source = createGetDesignKitSource({
      runCli: async () => ({ stdout: '', stderr: '', code: 0 }),
      workDirFactory,
    });

    await expect(source.getKit('raycast')).rejects.toThrow(
      /produced no DESIGN.md output/i,
    );
  });

  it('enforces the downloaded byte cap', async () => {
    const source = createGetDesignKitSource({
      runCli: runnerWriting('x'.repeat(2_048)),
      workDirFactory,
      maxKitBytes: 1_024,
    });

    await expect(source.getKit('raycast')).rejects.toThrow(/exceeded the .* cap/i);
    expect(GETDESIGN_MAX_KIT_BYTES).toBeGreaterThan(1_024);
  });

  it('removes the temporary work directory even when the run fails', async () => {
    const created: string[] = [];
    const runCli: GetDesignCliRunner = async ({ workDir: dir }) => {
      created.push(dir);
      throw new Error('boom');
    };
    const source = createGetDesignKitSource({ runCli, workDirFactory });

    await expect(source.getKit('raycast')).rejects.toThrow(/boom/);
    expect(created).toHaveLength(1);
    expect(fs.existsSync(created[0])).toBe(false);
  });

  it('lists brands as kit summaries', async () => {
    const source = createGetDesignKitSource({
      runCli: async () => ({ stdout: 'raycast\nlinear.app\n', stderr: '', code: 0 }),
      workDirFactory,
    });

    const kits = await source.listKits();

    expect(kits.map((kit) => kit.kitId)).toEqual(['raycast', 'linear.app']);
    expect(kits[0].sourceId).toBe('getdesign');
    expect(kits[1].title).toBe('Linear App');
  });
});

describe('resolveNpxCommand', () => {
  it('keeps the bare command on POSIX, where PATH resolves it', () => {
    expect(
      resolveNpxCommand({
        platform: 'darwin',
        pathString: '/usr/local/bin',
        exists: () => true,
      }),
    ).toBe('npx');
  });

  it('resolves npx.cmd on Windows, where shell:false never finds a bare npx', () => {
    const present = new Set(['C:\\Program Files\\nodejs\\npx.cmd']);
    expect(
      resolveNpxCommand({
        platform: 'win32',
        pathString: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
        exists: (candidate) => present.has(candidate),
      }),
    ).toBe('C:\\Program Files\\nodejs\\npx.cmd');
  });

  it('falls back to a real Windows executable name so the failure is honest', () => {
    expect(
      resolveNpxCommand({
        platform: 'win32',
        pathString: 'C:\\Windows\\System32',
        exists: () => false,
      }),
    ).toBe('npx.cmd');
  });
});

describe('temporary directory cleanup never replaces the real outcome', () => {
  it('still returns the fallback roster when the cleanup fails', async () => {
    const rmSync = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    try {
      const listed = await listGetDesignBrands({
        runCli: async () => {
          throw new Error('npx not found');
        },
        workDirFactory,
      });
      expect(listed.isFallback).toBe(true);
      expect(listed.brands).toBe(GETDESIGN_FALLBACK_BRANDS);
      expect(listed.detail).toContain('npx not found');
    } finally {
      rmSync.mockRestore();
    }
  });

  it('still surfaces the original CLI error when the cleanup fails', async () => {
    const rmSync = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    try {
      const source = createGetDesignKitSource({
        runCli: async () => ({ stdout: '', stderr: 'unknown brand', code: 1 }),
        workDirFactory,
      });
      await expect(source.getKit('nope')).rejects.toThrow(
        /exited with code 1: unknown brand/,
      );
    } finally {
      rmSync.mockRestore();
    }
  });
});

describe('a killed run is never a kit', () => {
  it('refuses the partial download when the CLI died from a signal', async () => {
    const runCli = vi.fn<GetDesignCliRunner>(async ({ args }) => {
      const outIndex = args.indexOf('--out');
      // The real CLI leaves a truncated file behind when it is killed.
      if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], '---\nname: Half\n');
      return { stdout: '', stderr: 'Killed', code: null };
    });
    const source = createGetDesignKitSource({ runCli, workDirFactory });

    await expect(source.getKit('raycast')).rejects.toThrow(
      /killed by a signal/i,
    );
  });
});
