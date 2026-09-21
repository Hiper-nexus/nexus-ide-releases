import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_CONSENT_BYTES = 64 * 1024;
const partitionHash = z.string().regex(/^[a-f0-9]{64}$/);
const consentSchema = z.object({ version: z.literal(1), partitions: z.array(partitionHash).max(500) }).strict();
function consentFile(userDataPath: string): string {
  return path.join(userDataPath, 'quota', 'mimo-console-consent.json');
}
function readConsent(userDataPath: string): string[] {
  try {
    const file = consentFile(userDataPath);
    if (fs.statSync(file).size > MAX_CONSENT_BYTES) return [];
    const parsed = consentSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.partitions : [];
  } catch { return []; }
}
export function hasMimoPartitionConsent(userDataPath: string, hash: string): boolean {
  return partitionHash.safeParse(hash).success && readConsent(userDataPath).includes(hash);
}
/** Only non-secret authorization is stored here; cookies stay in Electron. */
export function authorizeMimoPartition(userDataPath: string, hash: string): void {
  partitionHash.parse(hash);
  const partitions = [...new Set([...readConsent(userDataPath), hash])];
  const consent = consentSchema.parse({ version: 1, partitions });
  const file = consentFile(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(consent), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
