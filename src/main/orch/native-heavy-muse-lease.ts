import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileAtomicAsync } from '../util/atomic-write';

type ObjectValue = Record<string, unknown>;
type Owner = { id: string; pid: number; count: number };
type Group = { hook: ObjectValue; inserted: boolean; committed: boolean; owners: Owner[] };
interface RecordValue { schema: 'nexus.muse-hook-lease/v1'; settingsPath: string; hooksAbsent: boolean; preToolUseAbsent: boolean; groups: Group[] }
interface Snapshot { raw: string; stat: fs.Stats }
const INSTANCE = randomUUID();
const schema = 'nexus.muse-hook-lease/v1';
const MARKER = 'NEXUS_HEAVY_MUSE_LEASE_V1=1 ';
// A holder keeps the lock only for a few small writes. An older lock is abandoned
// even when its pid was reused by an unrelated process.
const LOCK_STALE_MS = 30_000, LOCK_ATTEMPTS = 200;
// Muse may rewrite settings.json with another key order; compare entries structurally.
const sorted = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const equal = (a: unknown, b: unknown) => sorted(a) === sorted(b);
const object = (value: unknown): ObjectValue => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('muse_heavy_lease_invalid'); return value as ObjectValue; };
const rootFor = (artifactRoot?: string) => path.join(artifactRoot ?? path.join(os.homedir(), '.nexus', 'ephemeral', 'mcp-clients'), 'muse', 'leases');
const keyFor = (settings: string) => createHash('sha256').update(settings).digest('hex');
function absentProcess(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
/** Our pid with another instance id is a previous Main; otherwise only ESRCH proves absence. */
const gone = (pid: number, id: unknown) => pid === process.pid ? id !== INSTANCE : absentProcess(pid);
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function lstat(file: string): Promise<fs.Stats | undefined> { try { return await fs.promises.lstat(file); } catch (error) { if (isMissing(error)) return; throw error; } }
async function read(file: string, limit: number, maxLinks = 1): Promise<Snapshot | undefined> {
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.nlink) throw new Error('muse_heavy_lease_changed'); // unlinked or replaced after open
    if (!stat.isFile() || stat.nlink > maxLinks || stat.size > limit) throw new Error('muse_heavy_lease_invalid');
    const bytes = Buffer.alloc(stat.size + 1); let total = 0;
    while (total < bytes.length) { const part = await handle.read(bytes, total, bytes.length - total, total); if (!part.bytesRead) break; total += part.bytesRead; }
    if (total !== stat.size) throw new Error('muse_heavy_lease_changed');
    return { raw: bytes.subarray(0, total).toString('utf8'), stat };
  } finally { await handle.close(); }
}
function same(now: fs.Stats | undefined, previous: Snapshot | undefined): void {
  if (!now && !previous) return;
  if (!now || !previous || !now.isFile() || now.dev !== previous.stat.dev || now.ino !== previous.stat.ino || now.size !== previous.stat.size || now.mtimeMs !== previous.stat.mtimeMs) throw new Error('muse_heavy_lease_changed');
}
async function publish(file: string, value: unknown, previous: Snapshot | undefined, current: () => void): Promise<void> {
  const raw = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(raw) > 1_048_576) throw new Error('muse_heavy_lease_invalid');
  await writeFileAtomicAsync(file, raw, 0o600, { createDirectory: false, beforeCommit: () => {
    current();
    // ponytail: the atomic writer's commit fence is synchronous; this single lstat
    // right before rename keeps the foreign-edit window to one syscall.
    let now: fs.Stats | undefined;
    try { now = fs.lstatSync(file); } catch (error) { if (!isMissing(error)) throw error; }
    same(now, previous);
  } });
}
function parseRecord(raw: string): RecordValue {
  const value = object(JSON.parse(raw));
  if (value.schema !== schema || typeof value.settingsPath !== 'string' || !path.isAbsolute(value.settingsPath) || path.basename(value.settingsPath) !== 'settings.json' ||
      typeof value.hooksAbsent !== 'boolean' || typeof value.preToolUseAbsent !== 'boolean' || !Array.isArray(value.groups) || value.groups.length > 32) throw new Error('muse_heavy_lease_invalid');
  for (const item of value.groups) {
    const group = object(item), hook = object(group.hook), handlers = hook.hooks;
    if (typeof group.inserted !== 'boolean' || typeof group.committed !== 'boolean' || hook.matcher !== 'bash' || !Array.isArray(handlers) || handlers.length !== 1 ||
        typeof object(handlers[0]).command !== 'string' || !(object(handlers[0]).command as string).startsWith(MARKER) ||
        !Array.isArray(group.owners) || group.owners.length > 32) throw new Error('muse_heavy_lease_invalid');
    for (const item of group.owners) { const owner = object(item); if (typeof owner.id !== 'string' || owner.id.length > 64 || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0 || !Number.isInteger(owner.count) || Number(owner.count) < 1 || Number(owner.count) > 1024) throw new Error('muse_heavy_lease_invalid'); }
  }
  return value as unknown as RecordValue;
}
function hooksOf(document: ObjectValue): { hooks: ObjectValue; entries: unknown[] } {
  const hooks = document.hooks === undefined ? {} : object(document.hooks), entries = hooks.PreToolUse ?? [];
  if (!Array.isArray(entries)) throw new Error('muse_heavy_hooks_invalid');
  return { hooks, entries };
}
function abandoned(previous: Snapshot): boolean {
  if (Date.now() - previous.stat.mtimeMs > LOCK_STALE_MS) return true;
  let owner: ObjectValue;
  try { owner = object(JSON.parse(previous.raw)); } catch { return false; } // unknown owner: only age frees it
  return Number.isInteger(owner.pid) && Number(owner.pid) > 0 && gone(Number(owner.pid), owner.id);
}
/** Unlink works by name only: move the judged lock aside and give back anything that raced into its place. */
async function breakLock(lock: string, previous: Snapshot): Promise<void> {
  const aside = `${lock}.${randomUUID()}.stale`;
  try { await fs.promises.rename(lock, aside); } catch (error) { if (isMissing(error)) return; throw error; }
  try {
    const moved = await fs.promises.lstat(aside);
    // ponytail: a third contender can still claim between rename and link-back;
    // publish() snapshot fences then reject the losing write instead of merging it.
    if (moved.dev !== previous.stat.dev || moved.ino !== previous.stat.ino) await fs.promises.link(aside, lock).catch(() => {});
  } finally { await fs.promises.unlink(aside); }
}
async function locked<T>(directory: string, key: string, operation: (file: string) => Promise<T>): Promise<T> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.promises.realpath(directory) !== directory) throw new Error('muse_heavy_lease_changed');
  const lock = path.join(directory, `${key}.lock`), prepared = `${lock}.${randomUUID()}.owner`;
  let identity: fs.Stats | undefined, claimed = false;
  const mine = (stat: fs.Stats | undefined) => Boolean(stat && identity && stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino);
  try {
    // The complete, durable owner exists before the atomic link publishes it as the lock.
    const handle = await fs.promises.open(prepared, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, id: INSTANCE })); await handle.sync(); identity = await handle.stat(); }
    finally { await handle.close(); }
    for (let attempt = 0; !claimed; attempt++) {
      if (attempt === LOCK_ATTEMPTS) throw new Error('muse_heavy_lease_busy');
      try { await fs.promises.link(prepared, lock); claimed = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // owner + lock (+ a breaker's aside name); a lock released while we opened it is simply retried
        const previous = await read(lock, 2048, 3).catch((error: Error) => { if (error.message === 'muse_heavy_lease_changed') return undefined; throw error; });
        if (previous && abandoned(previous)) await breakLock(lock, previous); else await delay(25);
      }
    }
    if (!mine(await lstat(lock))) throw new Error('muse_heavy_lease_changed');
    return await operation(path.join(directory, `${key}.json`));
  } finally {
    try { if (claimed) { if (!mine(await lstat(lock))) throw new Error('muse_heavy_lease_changed'); await fs.promises.unlink(lock); } }
    finally { if (mine(await lstat(prepared))) await fs.promises.unlink(prepared); }
  }
}
/** Drop dead owners, remove only entries this ledger inserted, then retire or rewrite the ledger. */
async function collect(file: string, record: RecordValue, snapshot: Snapshot): Promise<boolean> {
  const settings = await read(record.settingsPath, 1_048_576);
  const document = settings ? object(JSON.parse(settings.raw)) : {}, { hooks, entries } = hooksOf(document);
  for (const group of record.groups) group.owners = group.owners.filter(owner => !gone(owner.pid, owner.id));
  // An absent leased entry was already removed (operator edit or an interrupted
  // earlier release): nothing is left to restore and foreign entries stay.
  const ours = record.groups.filter(group => !group.owners.length && group.inserted).map(group => group.hook);
  const next = entries.filter(entry => !ours.some(hook => equal(entry, hook)));
  if (next.length !== entries.length) {
    const newHooks: ObjectValue = { ...hooks, PreToolUse: next };
    if (!next.length && record.preToolUseAbsent) delete newHooks.PreToolUse;
    if (!Object.keys(newHooks).length && record.hooksAbsent) delete document.hooks; else document.hooks = newHooks;
    await publish(record.settingsPath, document, settings, () => {});
  }
  record.groups = record.groups.filter(group => group.owners.length);
  if (record.groups.length) await publish(file, record, snapshot, () => {});
  else { same(await lstat(file), snapshot); await fs.promises.unlink(file); }
  return !record.groups.length;
}
/** The selected config/auth directory stays in place. Only one public constant hook is leased. */
export function createMuseNativeHeavySettingsLease(settingsPath: string, hook: ObjectValue, artifactRoot?: string): { acquire(current: () => void): Promise<void>; release(): Promise<void> } {
  const directory = rootFor(artifactRoot); let held = false, releasedData = false, canonical: string | undefined;
  return {
    async acquire(current) {
      // Dotfile managers link these. Never follow or replace an operator link (no ledger either).
      for (const file of [path.dirname(settingsPath), settingsPath]) { current(); if ((await lstat(file))?.isSymbolicLink()) throw new Error('muse_heavy_lease_symlink'); }
      current(); await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 }); current();
      canonical = path.join(await fs.promises.realpath(path.dirname(settingsPath)), 'settings.json'); current();
      await locked(directory, keyFor(canonical), async file => {
        current(); const previous = await read(file, 262144); current();
        const settings = await read(canonical!, 1_048_576); current(); const document = settings ? object(JSON.parse(settings.raw)) : {}, { hooks, entries } = hooksOf(document);
        const record: RecordValue = previous ? parseRecord(previous.raw) : { schema, settingsPath: canonical!, hooksAbsent: document.hooks === undefined, preToolUseAbsent: hooks.PreToolUse === undefined, groups: [] };
        if (record.settingsPath !== canonical) throw new Error('muse_heavy_lease_changed');
        const present = entries.some(entry => equal(entry, hook));
        let group = record.groups.find(item => equal(item.hook, hook));
        if (!group) { group = { hook, inserted: !present, committed: false, owners: [] }; record.groups.push(group); }
        else if (!present) group.inserted = true; // re-inserting a removed entry makes it ours to remove
        let owner = group.owners.find(owner => owner.id === INSTANCE);
        if (owner) owner.count++; else { owner = { id: INSTANCE, pid: process.pid, count: 1 }; group.owners.push(owner); }
        // Persist the public restoration intent before touching selected config.
        await publish(file, record, previous, current); held = true; current();
        if (!present) await publish(canonical!, { ...document, hooks: { ...hooks, PreToolUse: [...entries, hook] } }, settings, current);
        // Acknowledge our completed config write even if this pane was cancelled;
        // cleanup still needs this public restoration receipt.
        group.committed = true;
        await publish(file, record, await read(file, 262144), () => {});
      });
      current();
    },
    async release() {
      if (!held || !canonical) return;
      await locked(directory, keyFor(canonical), async file => {
        if (releasedData) return;
        const snapshot = await read(file, 262144); if (!snapshot) throw new Error('muse_heavy_lease_changed');
        const record = parseRecord(snapshot.raw), group = record.groups.find(group => equal(group.hook, hook)), owner = group?.owners.find(owner => owner.id === INSTANCE);
        if (!owner || owner.pid !== process.pid) throw new Error('muse_heavy_lease_changed');
        if (--owner.count === 0) group!.owners = group!.owners.filter(value => value !== owner);
        await collect(file, record, snapshot); releasedData = true;
      });
      held = false;
    },
  };
}
/** Dead-owner restoration only; this never grants/releases a command permit or kills a process. */
export async function recoverMuseNativeHeavyLeases(options: { artifactRoot?: string } = {}): Promise<{ restored: number; retained: number; failed: number }> {
  const result = { restored: 0, retained: 0, failed: 0 }, directory = rootFor(options.artifactRoot);
  let names: string[]; try { names = await fs.promises.readdir(directory); } catch (error) { if (isMissing(error)) return result; throw error; }
  if (names.length > 512) { result.failed++; return result; }
  for (const name of names.filter(name => /^[0-9a-f]{64}\.json$/.test(name))) {
    try {
      const empty = await locked(directory, name.slice(0, 64), async file => {
        const snapshot = await read(file, 262144); if (!snapshot) return true;
        const record = parseRecord(snapshot.raw);
        if (keyFor(record.settingsPath) !== name.slice(0, 64)) throw new Error('muse_heavy_lease_invalid');
        return collect(file, record, snapshot);
      });
      if (empty) result.restored++; else result.retained++;
    } catch { result.failed++; }
  }
  return result;
}
