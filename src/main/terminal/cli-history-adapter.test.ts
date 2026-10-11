import { describe, expect, it } from 'vitest';
import { createCommandBlock } from '../../shared/command-block';
import { CLI_HISTORY_PANE_ID, commandHistoryOriginOf } from '../../shared/cli-history';
import type { ImportedCommandBlock } from './cli-history-import';
import { adaptImportedCommandBlock, cliHistorySessionId } from './cli-history-adapter';

function imported(overrides: Partial<ImportedCommandBlock> = {}): ImportedCommandBlock {
  return {
    sessionId: cliHistorySessionId('claude', 'projects/a/s1.jsonl'),
    paneId: 'imported',
    workspaceId: 'imported',
    command: 'npm test',
    cwd: '/workspace',
    shell: 'bash',
    startedAt: 1_700_000_000_000,
    status: 'unknown',
    ...overrides,
  };
}

const target = { workspaceId: 'checkout-1', projectRoot: '/workspace' };

describe('adaptImportedCommandBlock', () => {
  it('produz um CreateCommandBlockInput válido, marcado como importado', () => {
    const input = adaptImportedCommandBlock(imported(), target);
    expect(input).not.toBeNull();
    // Passa pelo schema canônico do bloco.
    const block = createCommandBlock(input!);
    expect(block.paneId).toBe(CLI_HISTORY_PANE_ID);
    expect(block.workspaceId).toBe('checkout-1');
    expect(block.projectRoot).toBe('/workspace');
    expect(block.status).toBe('unknown');
    expect(block.exitCode).toBeUndefined();
    expect(commandHistoryOriginOf(block.sessionId)).toBe('imported');
    expect(block.id.length).toBeLessThanOrEqual(128);
  });

  it('é idempotente: o mesmo comando importado dá o mesmo id e a mesma chave', () => {
    const a = adaptImportedCommandBlock(imported(), target)!;
    const b = adaptImportedCommandBlock(imported(), target)!;
    expect(a.id).toBe(b.id);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    const other = adaptImportedCommandBlock(imported({ startedAt: 1 }), target)!;
    expect(other.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it('redige segredos como o caminho normal e registra a redação', () => {
    const input = adaptImportedCommandBlock(
      imported({
        command: 'curl -H "Authorization: Bearer abcd.efgh.ijkl" https://api.example/v1',
      }),
      target,
    )!;
    expect(input.command).not.toContain('abcd.efgh');
    expect(input.command).toContain('[REDACTED]');
    expect(input.redaction.redacted).toBe(true);
    expect(input.redaction.secretHits).toBeGreaterThan(0);
  });

  it('a chave nasce do comando já redigido (segredo nunca entra no hash)', () => {
    const a = adaptImportedCommandBlock(
      imported({ command: 'export TOKEN=sk-aaaaaaaaaaaaaaaaaaaaaaaa' }),
      target,
    )!;
    const b = adaptImportedCommandBlock(
      imported({ command: 'export TOKEN=sk-bbbbbbbbbbbbbbbbbbbbbbbb' }),
      target,
    )!;
    expect(a.command).toBe(b.command);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it('recusa entrada que o histórico não aceita', () => {
    expect(adaptImportedCommandBlock(imported({ command: '   ' }), target)).toBeNull();
    expect(adaptImportedCommandBlock(imported({ cwd: '' }), target)).toBeNull();
    expect(
      adaptImportedCommandBlock(imported({ startedAt: Number.NaN }), target),
    ).toBeNull();
  });
});

describe('cliHistorySessionId', () => {
  it('é estável, curto e carrega o adaptador', () => {
    const id = cliHistorySessionId('codex', 'sessions/2026/x.jsonl');
    expect(id).toBe(cliHistorySessionId('codex', 'sessions/2026/x.jsonl'));
    expect(id.startsWith('cli-import:codex:')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(cliHistorySessionId('codex', 'y.jsonl')).not.toBe(id);
    expect(cliHistorySessionId('x'.repeat(300), 'y.jsonl').length).toBeLessThanOrEqual(128);
  });
});
