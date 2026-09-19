import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOUNDARY_WINDOW_BYTES,
  HEAD_WINDOW_BYTES,
  MIN_RESUMABLE_PREFIX_BYTES,
  findLastLineBoundary,
  isResumablePrefixLength,
  prefixWindowLayout,
  readPrefixDigests,
  verifyResumedPrefix,
} from './codex-rollout-resume-state';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rolloutFile(
  prefixBytes: number,
  mutate?: (bytes: Buffer<ArrayBufferLike>) => Buffer<ArrayBufferLike>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
  roots.push(dir);
  const file = path.join(dir, 'rollout-x.jsonl');
  const head = Buffer.from(
    `${JSON.stringify({ type: 'session_meta', payload: { session_id: 's', cwd: '/w' } })}\n`,
  );
  const filler = Buffer.alloc(prefixBytes - head.length - 1, 0x61);
  let bytes: Buffer<ArrayBufferLike> = Buffer.concat([
    head,
    filler,
    Buffer.from('\n'),
  ]);
  if (mutate) bytes = mutate(bytes);
  fs.writeFileSync(file, bytes);
  return file;
}

describe('resume floor and window layout', () => {
  it('refuses prefixes at or below three windows', () => {
    expect(isResumablePrefixLength(MIN_RESUMABLE_PREFIX_BYTES)).toBe(false);
    expect(isResumablePrefixLength(MIN_RESUMABLE_PREFIX_BYTES + 1)).toBe(true);
    expect(isResumablePrefixLength(Number.NaN)).toBe(false);
    expect(isResumablePrefixLength(-1)).toBe(false);
  });

  it('lays head and boundary windows disjoint past the floor', () => {
    const layout = prefixWindowLayout(MIN_RESUMABLE_PREFIX_BYTES + 1);
    expect(layout.head).toEqual({ start: 0, endExclusive: HEAD_WINDOW_BYTES });
    expect(layout.boundary.endExclusive).toBe(MIN_RESUMABLE_PREFIX_BYTES + 1);
    expect(layout.boundary.start).toBe(
      MIN_RESUMABLE_PREFIX_BYTES + 1 - BOUNDARY_WINDOW_BYTES,
    );
    expect(layout.boundary.start).toBeGreaterThanOrEqual(
      layout.head.endExclusive,
    );
  });

  it('finds the byte offset past the last newline', () => {
    expect(findLastLineBoundary(Buffer.from('ab\ncd\n'))).toBe(6);
    expect(findLastLineBoundary(Buffer.from('ab\r\ncd\r\n'))).toBe(8);
    expect(findLastLineBoundary(Buffer.from('no-newline'))).toBe(-1);
    expect(findLastLineBoundary(Buffer.from(''))).toBe(-1);
  });
});

describe('prefix verification', () => {
  it('accepts an unchanged prefix and rejects a rewritten head', async () => {
    const offset = MIN_RESUMABLE_PREFIX_BYTES + 500;
    const file = rolloutFile(offset + 2000);
    const digests = await readPrefixDigests(file, offset);
    expect(digests).not.toBeNull();
    const record = { offset, ...digests! };
    expect(await verifyResumedPrefix(file, record)).toBe(true);

    const bytes = fs.readFileSync(file);
    bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61;
    fs.writeFileSync(file, bytes);
    expect(await verifyResumedPrefix(file, record)).toBe(false);
  });

  it('rejects a rewritten boundary window', async () => {
    const offset = MIN_RESUMABLE_PREFIX_BYTES + 500;
    const file = rolloutFile(offset + 2000);
    const record = { offset, ...(await readPrefixDigests(file, offset))! };
    expect(await verifyResumedPrefix(file, record)).toBe(true);

    const bytes = fs.readFileSync(file);
    bytes[offset - 10] = bytes[offset - 10] === 0x61 ? 0x62 : 0x61;
    fs.writeFileSync(file, bytes);
    expect(await verifyResumedPrefix(file, record)).toBe(false);
  });

  it('rejects truncation below the offset and short prefixes', async () => {
    const offset = MIN_RESUMABLE_PREFIX_BYTES + 500;
    const file = rolloutFile(offset + 2000);
    const record = { offset, ...(await readPrefixDigests(file, offset))! };
    fs.truncateSync(file, offset - 100);
    expect(await verifyResumedPrefix(file, record)).toBe(false);
    expect(await readPrefixDigests(file, 100)).toBeNull();
    expect(
      await verifyResumedPrefix(file, { offset: 100, headDigest: 'x', boundaryDigest: 'y' }),
    ).toBe(false);
  });

  it('rejects a missing file without throwing', async () => {
    await expect(
      verifyResumedPrefix('/nao/existe.jsonl', {
        offset: MIN_RESUMABLE_PREFIX_BYTES + 1,
        headDigest: 'x',
        boundaryDigest: 'y',
      }),
    ).resolves.toBe(false);
  });
});
