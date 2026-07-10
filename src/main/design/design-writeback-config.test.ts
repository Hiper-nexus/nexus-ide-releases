import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignWritebackConfig } from './design-writeback-config';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-config-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  fs.mkdirSync(path.join(root, '.nexus'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.nexus', 'design.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

describe('loadDesignWritebackConfig', () => {
  it('defaults to disabled when the project has no config (opt-in contract)', () => {
    expect(loadDesignWritebackConfig(root)).toEqual({
      enabled: false,
      styleMode: 'tailwind',
    });
  });

  it('reads the opt-in flag and style mode from .nexus/design.json', () => {
    writeConfig({ writeBack: { enabled: true, styleMode: 'inline' } });
    expect(loadDesignWritebackConfig(root)).toEqual({
      enabled: true,
      styleMode: 'inline',
    });
  });

  it('tolerates malformed json and unknown fields (never crash the IDE)', () => {
    writeConfig('{ not json');
    expect(loadDesignWritebackConfig(root).enabled).toBe(false);
    writeConfig({ writeBack: { enabled: 'yes', extra: 1 } });
    expect(loadDesignWritebackConfig(root).enabled).toBe(false);
  });

  it('fails closed for symlinked and oversized workspace config files', () => {
    const external = path.join(root, 'external.json');
    fs.writeFileSync(
      external,
      JSON.stringify({ writeBack: { enabled: true, styleMode: 'inline' } }),
    );
    fs.mkdirSync(path.join(root, '.nexus'), { recursive: true });
    fs.symlinkSync(external, path.join(root, '.nexus', 'design.json'));
    expect(loadDesignWritebackConfig(root).enabled).toBe(false);

    fs.unlinkSync(path.join(root, '.nexus', 'design.json'));
    fs.writeFileSync(
      path.join(root, '.nexus', 'design.json'),
      JSON.stringify({ writeBack: { enabled: true }, padding: 'x'.repeat(70_000) }),
    );
    expect(loadDesignWritebackConfig(root).enabled).toBe(false);
  });

  it('fails closed when the .nexus directory is a symlink', () => {
    const externalDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-design-config-external-'),
    );
    try {
      fs.writeFileSync(
        path.join(externalDir, 'design.json'),
        JSON.stringify({ writeBack: { enabled: true } }),
      );
      fs.symlinkSync(externalDir, path.join(root, '.nexus'));
      expect(loadDesignWritebackConfig(root).enabled).toBe(false);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
