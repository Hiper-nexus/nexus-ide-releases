import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCatalogOverlay, saveCatalogOverlay } from './catalog-overlay';

describe('catalog overlay persistence bounds', () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-overlay-test-'));
    file = path.join(home, '.nexus', 'catalog-overlay.json');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('rejects a 129th workspace without changing the accepted file', () => {
    for (let index = 0; index < 128; index += 1) {
      saveCatalogOverlay({
        workspacePath: path.join(home, `workspace-${index}`),
        stacks: ['node'],
      });
    }
    const accepted = fs.readFileSync(file);

    expect(() =>
      saveCatalogOverlay({
        workspacePath: path.join(home, 'workspace-128'),
        stacks: ['electron'],
      }),
    ).toThrow(/workspace limit/i);
    expect(fs.readFileSync(file)).toEqual(accepted);
  });

  it('rejects the first exact on-disk encoding over 1 MiB atomically', () => {
    const categories = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `category-${String(index).padStart(3, '0')}-${'k'.repeat(105)}`,
        `value-${'v'.repeat(114)}`,
      ]),
    );
    let accepted = Buffer.alloc(0);
    let rejected: unknown;

    for (let index = 0; index < 20 && rejected === undefined; index += 1) {
      try {
        saveCatalogOverlay({
          workspacePath: path.join(home, `large-workspace-${index}`),
          categories,
        });
        accepted = fs.readFileSync(file);
      } catch (error) {
        rejected = error;
      }
    }

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/file byte budget/i);
    expect(accepted.byteLength).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(fs.readFileSync(file)).toEqual(accepted);
  });

  it('fails closed on structurally malformed persisted workspace values', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        workspaces: {
          [path.join(home, 'workspace')]: {
            workspacePath: path.join(home, 'workspace'),
            stacks: 'electron',
            disabled: [],
            tombstones: [],
            categories: {},
            updatedAt: Date.now(),
          },
        },
      }),
    );

    expect(getCatalogOverlay(path.join(home, 'workspace'))).toEqual({
      workspacePath: path.join(home, 'workspace'),
      stacks: [],
      disabled: [],
      tombstones: [],
      categories: {},
      updatedAt: 0,
    });
  });
});
