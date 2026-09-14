import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** All checkouts on the release account share this lock. Never steal it on a timeout. */
export async function withPublicationLock(action, {
  lockPath = path.join(os.tmpdir(), 'nexus-ide-release-publication.lock'),
} = {}) {
  try { fs.mkdirSync(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another publication owns the release lock ${lockPath}. Wait for it to finish; after a crash, inspect owner.json and confirm its process stopped before removing the lock.`);
    throw error;
  }
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = randomUUID();
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (error) { fs.rmdirSync(lockPath); throw error; }
  try { return await action(); }
  finally {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (owner.token !== token) throw new Error('Publication lock ownership changed; refusing to remove another session lock');
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
  }
}
