import { describe, expect, it } from 'vitest';
import { OperatorInputReceipts } from './operator-input-receipts';

describe('Main-owned human prompt receipts', () => {
  it('requires a complete exact human submission, including split paste and backspace', () => {
    const receipts = new OperatorInputReceipts();
    receipts.record('s', 'use typx\bes', 'human', undefined, 1);
    expect(receipts.matches('s', 'use types', 2)).toBe(false);
    receipts.record('s', '\r', 'human', undefined, 3);
    expect(receipts.matches('s', 'use types', 4)).toBe(true);
    expect(receipts.matches('s', 'types', 4)).toBe(false);
    receipts.record('s', '\x1b[20', 'human', undefined, 5);
    receipts.record('s', '0~line one\nline two\x1b[201~\r', 'human', undefined, 6);
    expect(receipts.matches('s', 'line one\nline two', 7)).toBe(true);
  });

  it('rejects cursor editing, oversized or stale submissions and session reuse', () => {
    const receipts = new OperatorInputReceipts();
    receipts.record('s', 'hello\x1b[D!\r', 'human', undefined, 1);
    expect(receipts.matches('s', 'hello!', 2)).toBe(false);
    receipts.record('s', `${'x'.repeat(40_000)}\r`, 'human', undefined, 3);
    expect(receipts.matches('s', 'x'.repeat(40_000), 4)).toBe(false);
    receipts.record('s', 'fresh\r', 'human', undefined, 5);
    expect(receipts.matches('s', 'fresh', 70_000)).toBe(false);
    receipts.forget('s');
    expect(receipts.matches('s', 'fresh', 6)).toBe(false);
  });

  it('system input revokes the receipt and exposes only finite provenance', () => {
    const receipts = new OperatorInputReceipts();
    receipts.record('s', 'always use tabs\r', 'human', undefined, 1);
    receipts.record('s', 'always use tabs\r', 'system', 'supervisor', 2);
    expect(receipts.matches('s', 'always use tabs', 3)).toBe(false);
    expect(receipts.attribution('s', 3)).toEqual({ inputOrigin: 'system', writer: 'supervisor' });
    expect(JSON.stringify(receipts.attribution('s', 3))).not.toContain('tabs');
    expect(receipts.attribution('missing', 3)).toEqual({ inputOrigin: 'unknown' });
    expect(receipts.attribution('s', 400_000)).toEqual({ inputOrigin: 'unknown' });
  });

  it('does not join human text across a system injection or aborted input', () => {
    const receipts = new OperatorInputReceipts();
    receipts.record('s', 'human', 'human', undefined, 1);
    receipts.record('s', 'injected', 'system', 'nexus', 2);
    receipts.record('s', '\r', 'human', undefined, 3);
    expect(receipts.matches('s', 'human', 4)).toBe(false);
    receipts.record('s', 'discard\x03real\r', 'human', undefined, 5);
    expect(receipts.matches('s', 'real', 6)).toBe(true);
  });
});
