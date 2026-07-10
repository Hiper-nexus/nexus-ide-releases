import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFileAtomic } from './atomic-json-file';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-settings-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'nested', 'settings.json');
}

describe('writeJsonFileAtomic', () => {
  it('writes complete JSON and leaves no temporary payload behind', () => {
    const filePath = temporaryFile();

    writeJsonFileAtomic(filePath, { provider: 'gemini-live', enabled: true });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      provider: 'gemini-live',
      enabled: true,
    });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['settings.json']);
  });

  it('keeps the previous destination intact when atomic replacement fails', () => {
    const filePath = temporaryFile();
    writeJsonFileAtomic(filePath, { provider: 'openai' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    expect(() => writeJsonFileAtomic(filePath, { provider: 'gemini-live' })).toThrow(
      'disk unavailable',
    );
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      provider: 'openai',
    });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['settings.json']);
  });
});
