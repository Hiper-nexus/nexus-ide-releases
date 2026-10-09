import { describe, expect, it } from 'vitest';
import {
  importCliHistoryBlocks,
  importCliHistoryFiles,
} from './cli-history-import';

const transcript = [
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-08T12:00:00.000Z',
    cwd: '/workspace/app',
    message: {
      content: [
        { type: 'text', text: 'vou rodar os testes' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'npm test' },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-10-08T12:00:05.000Z',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  }),
  'not-json',
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-08T12:01:00.000Z',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file: 'a.ts' } }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-08T12:02:00.000Z',
    message: {
      content: [{ type: 'tool_use', name: 'Bash', input: { command: '   ' } }],
    },
  }),
].join('\n');

describe('cli history import (T3)', () => {
  it('extracts only shell tool_use blocks with a real command', () => {
    const blocks = importCliHistoryBlocks(transcript, {
      sessionId: 'sess-1',
      missionId: 'mission-a',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      sessionId: 'sess-1',
      missionId: 'mission-a',
      command: 'npm test',
      cwd: '/workspace/app',
      status: 'unknown',
    });
    expect(blocks[0]?.startedAt).toBe(Date.parse('2026-10-08T12:00:00.000Z'));
  });

  it('skips unreadable lines without aborting the import', () => {
    const blocks = importCliHistoryBlocks(
      ['oops', JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }],
        },
      })].join('\n'),
      { sessionId: 's', cwd: '/w', shell: 'zsh' },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.shell).toBe('zsh');
    expect(blocks[0]?.cwd).toBe('/w');
  });

  it('imports several files keyed by their own sessionId', () => {
    const blocks = importCliHistoryFiles([
      {
        sessionId: 'a',
        jsonl: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }],
          },
        }),
      },
      {
        sessionId: 'b',
        jsonl: JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'bash', input: { command: 'git diff' } }],
          },
        }),
      },
    ]);
    expect(blocks.map((b) => [b.sessionId, b.command])).toEqual([
      ['a', 'git status'],
      ['b', 'git diff'],
    ]);
  });
});
