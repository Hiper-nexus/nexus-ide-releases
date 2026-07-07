import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptStore } from './transcript-store';

describe('TranscriptStore', () => {
  it('writes valid JSONL records in the NexusIDE transcripts directory shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-transcripts-'));
    const store = new TranscriptStore({
      baseDir: dir,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
    });

    const first = store.append('session/1', {
      role: 'user',
      text: 'abra o package.json',
      final: true,
    });
    store.append('session/1', {
      role: 'assistant',
      text: 'Abrindo o arquivo.',
      final: true,
    });

    expect(first).toEqual({
      ts: '2026-07-07T12:00:00.000Z',
      role: 'user',
      text: 'abra o package.json',
      audio_url: null,
      final: true,
    });
    const file = store.pathForSession('session/1');
    expect(path.basename(file)).toContain('session_1.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      first,
      {
        ts: '2026-07-07T12:00:00.000Z',
        role: 'assistant',
        text: 'Abrindo o arquivo.',
        audio_url: null,
        final: true,
      },
    ]);
  });

  it('skips partial deltas and rotates by date', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-transcripts-'));
    let now = new Date('2026-07-07T12:00:00.000Z');
    const store = new TranscriptStore({
      baseDir: dir,
      now: () => now,
    });

    expect(
      store.append('session/2', {
        role: 'user',
        text: 'abr',
        final: false,
      }),
    ).toBe(null);

    store.append('session/2', {
      role: 'user',
      text: 'abra',
      final: true,
    });
    const firstFile = store.pathForSession('session/2');
    now = new Date('2026-07-08T12:00:00.000Z');
    store.append('session/2', {
      role: 'assistant',
      text: 'abrindo',
      final: true,
    });
    const secondFile = store.pathForSession('session/2');

    expect(secondFile).not.toBe(firstFile);
    expect(fs.readFileSync(firstFile, 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(secondFile, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('rotates oversized corrupt files, truncates text and prunes expired files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-transcripts-'));
    const store = new TranscriptStore({
      baseDir: dir,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      maxFileBytes: 180,
      maxTextChars: 12,
      retentionDays: 1,
    });
    fs.mkdirSync(dir, { recursive: true });
    const expired = path.join(dir, '2026-07-05T12-00-00-000Z-old.jsonl');
    fs.writeFileSync(expired, '{"old":true}\n', 'utf-8');
    const corrupt = store.pathForSession('session/3');
    fs.writeFileSync(corrupt, `{not-json}\n${'x'.repeat(180)}`, 'utf-8');

    const record = store.append('session/3', {
      role: 'user',
      text: 'abcdefghijklmnopqrstuvwxyz',
      final: true,
    });
    const rotated = store.pathForSession('session/3');

    expect(record?.text).toBe('abcdefghijkl');
    expect(rotated).not.toBe(corrupt);
    expect(fs.existsSync(expired)).toBe(false);
    expect(JSON.parse(fs.readFileSync(rotated, 'utf-8').trim()).text).toBe(
      'abcdefghijkl',
    );
  });
});
