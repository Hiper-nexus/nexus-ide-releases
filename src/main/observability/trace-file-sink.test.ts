import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceFileSink } from './trace-file-sink';

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sink-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('bounded async trace persistence', () => {
  it('keeps dated lifecycle history across repeated size rotation and purges only old owned files', async () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'lifecycle-2026-09-18.ndjson'), 'old');
    fs.writeFileSync(path.join(dir, 'lifecycle-2026-09-19.ndjson'), 'within retention');
    fs.writeFileSync(path.join(dir, 'operator-notes.txt'), 'keep');
    const sink = new TraceFileSink(dir, { rotationBytes: 40 });
    const at = Date.parse('2026-10-03T12:00:00Z');
    for (let i = 0; i < 8; i++) {
      sink.enqueue(`${JSON.stringify({ kind: 'pty-exit', seq: i })}\n`, at, `${i}\n`);
      await sink.flush();
    }
    expect(fs.existsSync(path.join(dir, 'main.trace.ndjson.3'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'lifecycle-2026-10-03.ndjson'), 'utf8')).toBe('0\n1\n2\n3\n4\n5\n6\n7\n');
    expect(fs.existsSync(path.join(dir, 'lifecycle-2026-09-18.ndjson'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'lifecycle-2026-09-19.ndjson'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'operator-notes.txt'), 'utf8')).toBe('keep');
  });
  it('bounds queued bytes and retains capacity for lifecycle events under output flood', async () => {
    const sink = new TraceFileSink(temp());
    for (let i = 0; i < 200; i++) sink.enqueue(`${'x'.repeat(16_000)}\n`, Date.now());
    expect(sink.enqueue('exit\n', Date.now(), 'exit\n')).toBe(true);
    expect(sink.stats().queuedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(sink.stats().dropped).toBeGreaterThan(0);
    await sink.flush();
    expect(sink.stats().queuedBytes).toBe(0);
  });
});
