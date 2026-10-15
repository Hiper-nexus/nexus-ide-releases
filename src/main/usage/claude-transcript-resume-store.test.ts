import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTranscriptResumeStore } from './claude-transcript-resume-store';

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempFile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-resume-store-'));
  tempRoots.push(dir);
  const file = path.join(dir, 'resume.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

function record(offset: number) {
  return { offset, headDigest: `h-${offset}`, boundaryDigest: `b-${offset}` };
}

describe('ClaudeTranscriptResumeStore gravação', () => {
  it('não regrava o disco quando nada mudou desde a carga', async () => {
    const file = tempFile(JSON.stringify({ version: 1, files: { '/a.jsonl': record(100) } }));
    const store = new ClaudeTranscriptResumeStore(file);
    await store.loadAsync();
    const writeSpy = vi.spyOn(fsp, 'writeFile');
    await store.saveAsync();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('não cria o arquivo quando não há nada para gravar', async () => {
    const file = tempFile();
    const store = new ClaudeTranscriptResumeStore(file);
    await store.loadAsync();
    await store.saveAsync();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('set idêntico ao registro atual não dispara regravação', async () => {
    const file = tempFile();
    const store = new ClaudeTranscriptResumeStore(file);
    const writeSpy = vi.spyOn(fsp, 'writeFile');
    store.set('/a.jsonl', record(100));
    await store.saveAsync();
    expect(writeSpy).toHaveBeenCalledTimes(1);

    store.set('/a.jsonl', record(100));
    await store.saveAsync();
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('mudança feita durante a carga não é perdida', async () => {
    const file = tempFile(JSON.stringify({ version: 1, files: { '/a.jsonl': record(100) } }));
    const store = new ClaudeTranscriptResumeStore(file);
    const loading = store.loadAsync();
    store.set('/b.jsonl', record(200));
    await loading;
    await store.saveAsync();

    const reloaded = new ClaudeTranscriptResumeStore(file);
    expect(reloaded.get('/a.jsonl')?.offset).toBe(100);
    expect(reloaded.get('/b.jsonl')?.offset).toBe(200);
  });

  it('delete de registro ausente não grava; delete de existente grava', async () => {
    const file = tempFile(JSON.stringify({ version: 1, files: { '/a.jsonl': record(100) } }));
    const store = new ClaudeTranscriptResumeStore(file);
    await store.loadAsync();
    const writeSpy = vi.spyOn(fsp, 'writeFile');

    store.delete('/nao-existe.jsonl');
    await store.saveAsync();
    expect(writeSpy).not.toHaveBeenCalled();

    store.delete('/a.jsonl');
    await store.saveAsync();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(new ClaudeTranscriptResumeStore(file).get('/a.jsonl')).toBeNull();
  });
});
