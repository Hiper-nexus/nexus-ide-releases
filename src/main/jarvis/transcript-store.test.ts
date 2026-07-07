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
});
