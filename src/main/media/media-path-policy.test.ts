import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readMediaInput,
  resolveMediaOutputPath,
  writeMediaOutput,
} from './media-path-policy';

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-workspace-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-outside-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('media workspace path policy', () => {
  it('accepts relative and absolute output paths only inside the workspace', () => {
    expect(resolveMediaOutputPath('assets/hero.png', workspace)).toBe(
      path.join(workspace, 'assets/hero.png'),
    );
    expect(
      resolveMediaOutputPath(path.join(workspace, 'assets/hero.png'), workspace),
    ).toBe(path.join(workspace, 'assets/hero.png'));
    expect(() =>
      resolveMediaOutputPath(path.join(outside, 'stolen.png'), workspace),
    ).toThrow(/escapa o workspace/);
    expect(resolveMediaOutputPath('..assets/hero.png', workspace)).toBe(
      path.join(workspace, '..assets/hero.png'),
    );
  });

  it('rejects an output parent symlink that escapes the workspace', () => {
    fs.symlinkSync(outside, path.join(workspace, 'linked-outside'));
    expect(() =>
      resolveMediaOutputPath('linked-outside/result.png', workspace),
    ).toThrow(/escapa o workspace/);
  });

  it('rejects an existing output file symlink instead of overwriting its target', () => {
    const outsideFile = path.join(outside, 'victim.png');
    fs.writeFileSync(outsideFile, 'keep-me');
    const outputLink = path.join(workspace, 'result.png');
    fs.symlinkSync(outsideFile, outputLink);

    expect(() => writeMediaOutput(outputLink, workspace, Buffer.from('attack'))).toThrow(
      /symlink|escapa o workspace/,
    );
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('keep-me');
  });

  it('rejects an existing output hardlink instead of overwriting its peer', () => {
    const outsideFile = path.join(outside, 'victim.png');
    fs.writeFileSync(outsideFile, 'keep-me');
    const outputLink = path.join(workspace, 'result.png');
    fs.linkSync(outsideFile, outputLink);

    expect(() => writeMediaOutput(outputLink, workspace, Buffer.from('attack'))).toThrow(
      /hardlink/,
    );
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('keep-me');
  });

  it('reads a regular input inside the workspace and rejects a symlink escape', () => {
    const insideFile = path.join(workspace, 'input.png');
    fs.writeFileSync(insideFile, 'inside');
    expect(readMediaInput('input.png', workspace)).toMatchObject({
      path: fs.realpathSync(insideFile),
      data: Buffer.from('inside'),
    });

    const outsideFile = path.join(outside, 'private.png');
    fs.writeFileSync(outsideFile, 'outside');
    fs.symlinkSync(outsideFile, path.join(workspace, 'external-link.png'));
    expect(() => readMediaInput('external-link.png', workspace)).toThrow(
      /escapa o workspace/,
    );
  });

  it('rejects directories as media input', () => {
    fs.mkdirSync(path.join(workspace, 'folder'));
    expect(() => readMediaInput('folder', workspace)).toThrow(/arquivo regular/);
  });

  it('atomically replaces a regular output without leaving staging files', () => {
    const output = path.join(workspace, 'result.png');
    fs.writeFileSync(output, 'old');
    writeMediaOutput(output, workspace, Buffer.from('new'));
    expect(fs.readFileSync(output, 'utf8')).toBe('new');
    expect(fs.readdirSync(workspace)).toEqual(['result.png']);
  });
});
