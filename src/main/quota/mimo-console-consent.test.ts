import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizeMimoPartition, hasMimoPartitionConsent } from './mimo-console-consent';
let directory: string;
const partition = 'a'.repeat(64);
describe('MiMo private console consent', () => {
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-consent-')); });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  it('persists only opaque partition authorizations with private permissions', () => {
    expect(hasMimoPartitionConsent(directory, partition)).toBe(false);
    authorizeMimoPartition(directory, partition);
    expect(hasMimoPartitionConsent(directory, partition)).toBe(true);
    expect(hasMimoPartitionConsent(directory, 'b'.repeat(64))).toBe(false);
    const file = path.join(directory, 'quota', 'mimo-console-consent.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, partitions: [partition] });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('rejects malformed consent and invalid partition inputs without authorizing', () => {
    fs.mkdirSync(path.join(directory, 'quota'));
    fs.writeFileSync(path.join(directory, 'quota', 'mimo-console-consent.json'), JSON.stringify({ version: 1, partitions: [partition, '../invalid'] }));
    expect(hasMimoPartitionConsent(directory, partition)).toBe(false);
    expect(() => authorizeMimoPartition(directory, '../invalid')).toThrow();
  });
});
