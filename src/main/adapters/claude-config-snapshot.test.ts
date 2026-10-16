import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearClaudeConfigSnapshotCache,
  readClaudeConfigForDecision,
  readClaudeConfigSnapshot,
  readClaudeConfigSnapshotAsync,
} from './claude-config-snapshot';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-config-'));
  clearClaudeConfigSnapshotCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Mesmo tamanho em bytes para os dois e-mails: só o mtime denuncia a troca. */
function writeConfig(file: string, email: string, mtime?: Date): void {
  fs.writeFileSync(file, JSON.stringify({
    oauthAccount: { emailAddress: email, organizationUuid: 'org-1' },
  }));
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

describe('claude config snapshot (#18)', () => {
  it('serves an untouched file from the stamp cache without reparsing', async () => {
    const file = path.join(dir, '.claude.json');
    writeConfig(file, 'aaa@x.com');
    const first = await readClaudeConfigSnapshotAsync(file);
    expect(first?.email).toBe('aaa@x.com');
    expect(readClaudeConfigSnapshot(file)).toBe(first);
    expect(await readClaudeConfigSnapshotAsync(file)).toBe(first);
  });

  // No Windows o stamp (dev/ino/size/mtimeNs/ctimeNs) não denuncia a troca:
  // ctime é a data de criação no NTFS e nunca avança numa reescrita — não há
  // contador de mudança exposto pelo fs.stat para detectar cp -p/rsync.
  it.skipIf(process.platform === 'win32')('sees a same-size rewrite with a restored mtime (cp -p, rsync, coarse clocks) (M1)', async () => {
    const file = path.join(dir, '.claude.json');
    const pinned = new Date('2026-10-14T12:00:00Z');
    writeConfig(file, 'aaa@x.com', pinned);
    expect(readClaudeConfigSnapshot(file)?.email).toBe('aaa@x.com');
    writeConfig(file, 'bbb@x.com', pinned);
    // mtime and size are identical: the stamp must still notice (ctime/inode).
    expect(readClaudeConfigSnapshot(file)?.email).toBe('bbb@x.com');
    writeConfig(file, 'ccc@x.com', pinned);
    expect((await readClaudeConfigSnapshotAsync(file))?.email).toBe('ccc@x.com');
  });

  it('decision reads are fresh and tell absent from unknown (M1)', () => {
    const file = path.join(dir, '.claude.json');
    expect(readClaudeConfigForDecision(file)).toBeNull();
    const pinned = new Date('2026-10-14T12:00:00Z');
    writeConfig(file, 'aaa@x.com', pinned);
    expect(readClaudeConfigSnapshot(file)?.email).toBe('aaa@x.com');
    writeConfig(file, 'bbb@x.com', pinned);
    expect(readClaudeConfigForDecision(file)?.email).toBe('bbb@x.com');
    fs.writeFileSync(file, '{"oauthAccount": {"emailAddress": "half');
    expect(readClaudeConfigForDecision(file)).toBeUndefined();
    fs.truncateSync(file, 64 * 1024 * 1024 + 1);
    expect(readClaudeConfigForDecision(file)).toBeUndefined();
  });

  it('an async read in flight does not republish after the cache is cleared (L1)', async () => {
    const file = path.join(dir, '.claude.json');
    writeConfig(file, 'aaa@x.com');
    const pending = readClaudeConfigSnapshotAsync(file);
    clearClaudeConfigSnapshotCache();
    const stale = await pending;
    expect(stale?.email).toBe('aaa@x.com');
    // Not published: the next read parses again instead of serving it.
    expect(readClaudeConfigSnapshot(file)).not.toBe(stale);
  });

  it('drops the entry when the file disappears or exceeds the 64 MiB ceiling', async () => {
    const file = path.join(dir, '.claude.json');
    writeConfig(file, 'aaa@x.com');
    expect(readClaudeConfigSnapshot(file)?.organizationUuid).toBe('org-1');
    fs.truncateSync(file, 64 * 1024 * 1024 + 1);
    expect(await readClaudeConfigSnapshotAsync(file)).toBeNull();
    fs.rmSync(file);
    expect(readClaudeConfigSnapshot(file)).toBeNull();
  });

  it('returns null for malformed JSON instead of inventing an account', async () => {
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, '{not json');
    expect(await readClaudeConfigSnapshotAsync(file)).toBeNull();
  });
});
