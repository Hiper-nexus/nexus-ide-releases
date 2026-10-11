import { describe, expect, it } from 'vitest';
import {
  CLI_HISTORY_UNKNOWN_CWD,
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

  it('reads Codex rollout function_call shell and exec_command', () => {
    const blocks = importCliHistoryBlocks(
      [
        JSON.stringify({
          timestamp: '2026-10-08T12:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: JSON.stringify({
              command: ['/bin/zsh', '-lc', 'npm test'],
              workdir: '/workspace/app',
            }),
            call_id: 'call_1',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'git status', workdir: '/repo' }),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'Read',
            arguments: JSON.stringify({ path: 'a.ts' }),
          },
        }),
      ].join('\n'),
      { sessionId: 'codex-1', cwd: '/fallback' },
    );
    expect(blocks.map((block) => [block.command, block.cwd])).toEqual([
      ['npm test', '/workspace/app'],
      ['git status', '/repo'],
    ]);
    expect(blocks[0]?.startedAt).toBe(Date.parse('2026-10-08T12:00:00.000Z'));
    expect(blocks[0]?.status).toBe('unknown');
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

  it('F-1050: a null JSONL line does not abort the import of valid lines', () => {
    const blocks = importCliHistoryBlocks(
      [
        'null',
        '123',
        '"just-a-string"',
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-08T12:00:00.000Z',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
          },
        }),
      ].join('\n'),
      { sessionId: 'sess-null', cwd: '/w' },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.command).toBe('npm test');
  });

  it('sem cwd do chamador usa marcador fixo, não process.cwd() (chave estável)', () => {
    const line = JSON.stringify({
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    const [block] = importCliHistoryBlocks(line, { sessionId: 's' });
    expect(block?.cwd).toBe(CLI_HISTORY_UNKNOWN_CWD);
    expect(block?.cwd).not.toBe(process.cwd());
  });
});
