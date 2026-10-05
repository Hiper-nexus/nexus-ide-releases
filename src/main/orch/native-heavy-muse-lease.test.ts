import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';
import { createMuseNativeHeavySettingsLease, recoverMuseNativeHeavyLeases } from './native-heavy-muse-lease';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hook = { matcher: 'bash', hooks: [{ type: 'command', command: 'NEXUS_HEAVY_MUSE_LEASE_V1=1 NODE_OPTIONS= /Main/node /Main/heavy-command/muse-tool-hook.cjs' }] };
function fixture() {
 const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-muse-lease-'))); roots.push(root);
 const settings = path.join(root, 'selected/muse/settings.json'), artifactRoot = path.join(root, 'artifacts'); fs.mkdirSync(path.dirname(settings), { recursive: true });
 const original = { model: 'selected', credential: 'only-original-fixture', hooks: { Stop: [{ own: true }] } };
 fs.writeFileSync(settings, JSON.stringify(original));
 const ledgerRoot = path.join(artifactRoot, 'muse/leases'), key = createHash('sha256').update(settings).digest('hex');
 return { root, settings, artifactRoot, original, ledgerRoot, key, ledger: path.join(ledgerRoot, `${key}.json`), lock: path.join(ledgerRoot, `${key}.lock`), read: () => JSON.parse(fs.readFileSync(settings, 'utf8')) };
}
it('leases one constant hook across concurrent sessions, preserves foreign edits and restores on the last release', async () => {
 const f = fixture(), a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot), b = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot);
 await Promise.all([a.acquire(() => {}), b.acquire(() => {})]);
 expect(f.read().hooks.PreToolUse).toEqual([hook]);
 expect(JSON.parse(fs.readFileSync(f.ledger, 'utf8')).groups[0].owners).toEqual([expect.objectContaining({ pid: process.pid, count: 2 })]);
 expect(fs.readFileSync(f.ledger, 'utf8')).not.toContain(f.original.credential);
 await a.release(); await a.release(); expect(f.read().hooks.PreToolUse).toEqual([hook]);
 const edited = f.read(); edited.model = 'new-selected'; edited.hooks.Stop.push({ editor: true }); fs.writeFileSync(f.settings, JSON.stringify(edited));
 await b.release(); expect(f.read()).toEqual({ ...f.original, model: 'new-selected', hooks: { Stop: [{ own: true }, { editor: true }] } });
 expect(fs.readdirSync(f.ledgerRoot)).toEqual([]);
});
it('preserves an existing identical hook instead of claiming it and rejects a non-regular selected file without blocking', async () => {
 const f = fixture(); fs.writeFileSync(f.settings, JSON.stringify({ ...f.original, hooks: { PreToolUse: [hook] } }));
 const a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {}); await a.release(); expect(f.read().hooks.PreToolUse).toEqual([hook]);
 fs.unlinkSync(f.settings); fs.symlinkSync('/dev/null', f.settings);
 const b = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await expect(b.acquire(() => {})).rejects.toThrow(); expect(fs.lstatSync(f.settings).isSymbolicLink()).toBe(true);
});
it('never deletes a foreign rewrite of the leased entry; an already-removed entry retires the ledger without rewriting settings', async () => {
 const f = fixture(), a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {});
 const changed = f.read(); changed.hooks.PreToolUse[0].hooks[0].command = 'foreign'; fs.writeFileSync(f.settings, JSON.stringify(changed));
 const before = fs.statSync(f.settings);
 await a.release(); expect(f.read().hooks.PreToolUse[0].hooks[0].command).toBe('foreign');
 expect(fs.statSync(f.settings).ino).toBe(before.ino); expect(fs.existsSync(f.ledger)).toBe(false);
 // Interrupted release: settings restored, ledger not yet retired. A later collector is idempotent.
 fs.writeFileSync(f.settings, JSON.stringify(f.original)); const b = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await b.acquire(() => {});
 fs.writeFileSync(f.settings, JSON.stringify(f.original)); await b.release(); expect(f.read()).toEqual(f.original); expect(fs.existsSync(f.ledger)).toBe(false);
});
it('removes its entry after Muse reorders keys and re-owns an entry it had to re-insert', async () => {
 const f = fixture(), a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {});
 const reordered = f.read(); reordered.hooks.PreToolUse = [{ hooks: [{ command: hook.hooks[0].command, type: 'command' }], matcher: 'bash' }]; fs.writeFileSync(f.settings, JSON.stringify(reordered));
 await a.release(); expect(f.read()).toEqual(f.original);
 fs.writeFileSync(f.settings, JSON.stringify({ ...f.original, hooks: { PreToolUse: [hook] } }));
 const b = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot), c = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot);
 await b.acquire(() => {}); fs.writeFileSync(f.settings, JSON.stringify(f.original)); // operator removes the pre-existing copy while leased
 await c.acquire(() => {}); expect(f.read().hooks.PreToolUse).toEqual([hook]);
 await b.release(); expect(f.read().hooks.PreToolUse).toEqual([hook]); await c.release(); expect(f.read()).toEqual({ ...f.original, hooks: { Stop: [{ own: true }], PreToolUse: [] } });
});
it('publishes a complete owner before atomic lock claim; an interrupted prepared owner does not block another acquisition', async () => {
 const f = fixture(); fs.mkdirSync(f.ledgerRoot, { recursive: true });
 fs.writeFileSync(path.join(f.ledgerRoot, `${f.key}.lock.${randomUUID()}.owner`), '');
 const link = fs.promises.link.bind(fs.promises); let checked = 0;
 vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
  const body = JSON.parse(fs.readFileSync(source as string, 'utf8')); expect(body.pid).toBe(process.pid); expect(typeof body.id).toBe('string'); checked++;
  return link(source, target);
 });
 const a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {}); await a.release(); expect(checked).toBe(2);
 expect(fs.readdirSync(f.ledgerRoot)).toHaveLength(1); // incomplete unpublished file is preserved, never mistaken for an active lock
});
it('waits for a live lock, breaks a dead or abandoned one, and never breaks a fresh unknown owner', async () => {
 const f = fixture(); fs.mkdirSync(f.ledgerRoot, { recursive: true });
 fs.writeFileSync(f.lock, JSON.stringify({ pid: process.ppid, id: 'another-live-process' }));
 const live = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); let done = false;
 const waiting = live.acquire(() => {}).then(() => { done = true; });
 await new Promise(resolve => setTimeout(resolve, 150)); expect(done).toBe(false); expect(f.read().hooks.PreToolUse).toBeUndefined();
 fs.unlinkSync(f.lock); await waiting; await live.release();
 fs.writeFileSync(f.lock, JSON.stringify({ pid: 2147483647, id: 'dead-main' }));
 const dead = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await dead.acquire(() => {}); await dead.release();
 fs.writeFileSync(f.lock, JSON.stringify({ pid: 1, id: 'reused-pid' })); const old = new Date(Date.now() - 60_000); fs.utimesSync(f.lock, old, old);
 const abandoned = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await abandoned.acquire(() => {}); await abandoned.release();
 fs.writeFileSync(f.lock, 'not-json'); const unknown = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); done = false;
 const blocked = unknown.acquire(() => {}).then(() => { done = true; });
 await new Promise(resolve => setTimeout(resolve, 150)); expect(done).toBe(false); expect(fs.readFileSync(f.lock, 'utf8')).toBe('not-json');
 fs.unlinkSync(f.lock); await blocked; await unknown.release();
 expect(f.read()).toEqual(f.original); expect(fs.readdirSync(f.ledgerRoot)).toEqual([]);
});
it('keeps live or malformed owners, and restores a definitely absent owner without touching auth', async () => {
 const f = fixture(), auth = path.join(path.dirname(f.settings), 'auth.json'); fs.writeFileSync(auth, 'only-own-auth-fixture'); const authStat = fs.statSync(auth);
 const a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {});
 expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 0, retained: 1, failed: 0 });
 const record = JSON.parse(fs.readFileSync(f.ledger, 'utf8'));
 record.groups[0].owners[0].pid = 2147483647; fs.writeFileSync(f.ledger, JSON.stringify(record));
 expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 1, retained: 0, failed: 0 }); expect(f.read()).toEqual(f.original);
 expect(fs.statSync(auth).ino).toBe(authStat.ino); expect(fs.readFileSync(auth, 'utf8')).toBe('only-own-auth-fixture');
 fs.writeFileSync(f.ledger, '{}'); expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 0, retained: 0, failed: 1 }); expect(fs.existsSync(f.ledger)).toBe(true);
});
it('recovers a previous Main with this pid and an uncommitted crash between intent and receipt', async () => {
 const f = fixture(), a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {});
 const record = JSON.parse(fs.readFileSync(f.ledger, 'utf8')); record.groups[0].owners[0].id = 'previous-main-same-pid'; record.groups[0].committed = false;
 fs.writeFileSync(f.ledger, JSON.stringify(record));
 expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 1, retained: 0, failed: 0 }); expect(f.read()).toEqual(f.original);
});

// Real cross-process control: separate Node processes share only the files.
const CHILD = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const [bundle, settings, artifactRoot, ledger, mode, rounds] = process.argv.slice(2);
const { createMuseNativeHeavySettingsLease: lease } = require(bundle); const hook = JSON.parse(process.env.LEASE_HOOK);
const has = () => (JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.PreToolUse ?? []).some(entry => JSON.stringify(entry) === JSON.stringify(hook));
process.on('message', async () => {
  try {
    if (mode === 'hold') { await lease(settings, hook, artifactRoot).acquire(() => {}); process.send({ held: true }); return; }
    for (let round = 0; round < Number(rounds); round++) {
      const a = lease(settings, hook, artifactRoot), b = lease(settings, hook, artifactRoot);
      await Promise.all([a.acquire(() => {}), b.acquire(() => {})]);
      const own = JSON.parse(fs.readFileSync(ledger, 'utf8')).groups[0].owners.find(owner => owner.pid === process.pid);
      if (!has() || own?.count !== 2) throw new Error('lost update while holding: ' + JSON.stringify(own));
      await a.release(); if (!has()) throw new Error('entry removed while this process still holds b');
      await b.release();
    }
    process.send({ done: true }, () => process.disconnect());
  } catch (error) { process.send({ error: String(error && error.stack || error) }, () => process.disconnect()); }
});`;
it('two real Node processes contend for the same selected settings with exclusion, refcount and dead-owner recovery', async () => {
 const f = fixture(), bundle = path.join(f.root, 'lease.cjs'), child = path.join(f.root, 'child.cjs');
 await build({ entryPoints: [path.join(process.cwd(), 'src/main/orch/native-heavy-muse-lease.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
 fs.writeFileSync(child, CHILD);
 const children: ChildProcess[] = [];
 const start = (mode: string) => { const proc = fork(child, [bundle, f.settings, f.artifactRoot, f.ledger, mode, '20'], { execArgv: [], env: { PATH: '/usr/bin:/bin', HOME: f.root, LEASE_HOOK: JSON.stringify(hook) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(proc); return proc; };
 const reply = (proc: ChildProcess) => new Promise<Record<string, unknown>>((resolve, reject) => { proc.once('message', message => resolve(message as Record<string, unknown>)); proc.once('exit', code => reject(new Error(`child exited ${code}`))); });
 try {
  const racers = [start('race'), start('race')], results = racers.map(reply);
  for (const proc of racers) proc.send('go');
  expect(await Promise.all(results)).toEqual([{ done: true }, { done: true }]);
  expect(f.read()).toEqual(f.original); expect(fs.readdirSync(f.ledgerRoot)).toEqual([]);
  // A real Main dies holding the lease: the selected entry stays until a startup recovery proves the owner absent.
  const holder = start('hold'), held = reply(holder); holder.send('go'); expect(await held).toEqual({ held: true });
  expect(f.read().hooks.PreToolUse).toEqual([hook]); expect(JSON.parse(fs.readFileSync(f.ledger, 'utf8')).groups[0].owners[0].pid).toBe(holder.pid);
  const exited = new Promise(resolve => holder.once('exit', resolve)); holder.kill('SIGKILL'); await exited;
  expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 1, retained: 0, failed: 0 });
  expect(f.read()).toEqual(f.original); expect(fs.readdirSync(f.ledgerRoot)).toEqual([]);
 } finally { for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }
}, 30_000);
