import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearClaudeConfigSnapshotCache,
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
  it('reads the async snapshot without blocking calls and shares the stamp cache with the sync reader', async () => {
    const file = path.join(dir, '.claude.json');
    const pinned = new Date('2026-10-14T12:00:00Z');
    writeConfig(file, 'aaa@x.com', pinned);

    expect((await readClaudeConfigSnapshotAsync(file))?.email).toBe('aaa@x.com');
    // Same size and mtime: the cache stamp holds, nothing is reparsed.
    writeConfig(file, 'bbb@x.com', pinned);
    expect(readClaudeConfigSnapshot(file)?.email).toBe('aaa@x.com');
    expect((await readClaudeConfigSnapshotAsync(file))?.email).toBe('aaa@x.com');

    fs.utimesSync(file, new Date('2026-10-14T12:00:05Z'), new Date('2026-10-14T12:00:05Z'));
    expect((await readClaudeConfigSnapshotAsync(file))?.email).toBe('bbb@x.com');
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
