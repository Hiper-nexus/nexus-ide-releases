import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepCliHistory } from './cli-history-sweep';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seedProviderState(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-sweep-'));
  dirs.push(root);
  const session = path.join(root, 'provider-state', 'claude', 'checkout-a', 'projects');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(
    path.join(session, 'a.jsonl'),
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-08T12:00:00.000Z',
        cwd: '/w',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
      'not-json',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(session, 'big.jsonl'), 'x'.repeat(5_000));
  return root;
}

describe('cli history sweep (T3)', () => {
  it('walks provider-state and imports shell blocks, skipping oversized files', () => {
    const root = seedProviderState();
    const result = sweepCliHistory({
      userDataPath: root,
      sessionId: 'sess-import',
      // big.jsonl (5 KB) estoura; o a.jsonl real passa.
      maxBytesPerFile: 1_000,
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.command).toBe('npm test');
    expect(result.filesScanned).toBe(1);
    expect(result.filesSkipped).toBe(1);
  });

  it('returns empty when provider-state is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-empty-'));
    dirs.push(root);
    const result = sweepCliHistory({ userDataPath: root, sessionId: 's' });
    expect(result.blocks).toHaveLength(0);
    expect(result.filesScanned).toBe(0);
  });
});
