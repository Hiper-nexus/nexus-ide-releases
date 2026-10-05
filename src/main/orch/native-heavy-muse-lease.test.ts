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
  if (String(target).endsWith('.lock')) { const body = JSON.parse(fs.readFileSync(source as string, 'utf8')); expect(body.pid).toBe(process.pid); expect(typeof body.id).toBe('string'); checked++; }
  return link(source, target);
 });
 const a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {}); await a.release(); expect(checked).toBe(2);
 expect(fs.readdirSync(f.ledgerRoot)).toHaveLength(1); // incomplete unpublished file is preserved, never mistaken for an active lock
});
it('waits for a live lock, breaks only a provably dead one, and never breaks an old live pid or an unknown owner', async () => {
 const f = fixture(); fs.mkdirSync(f.ledgerRoot, { recursive: true });
 fs.writeFileSync(f.lock, JSON.stringify({ pid: process.ppid, id: 'another-live-process' }));
 const live = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); let done = false;
 const waiting = live.acquire(() => {}).then(() => { done = true; });
 await new Promise(resolve => setTimeout(resolve, 150)); expect(done).toBe(false); expect(f.read().hooks.PreToolUse).toBeUndefined();
 fs.unlinkSync(f.lock); await waiting; await live.release();
 fs.writeFileSync(f.lock, JSON.stringify({ pid: 2147483647, id: 'dead-main' }));
 const dead = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await dead.acquire(() => {}); await dead.release();
 // Age is no proof of death: a live (possibly reused) pid keeps its lock; the waiter degrades instead.
 fs.writeFileSync(f.lock, JSON.stringify({ pid: process.ppid, id: 'old-live-holder' })); const old = new Date(Date.now() - 60_000); fs.utimesSync(f.lock, old, old);
 const patient = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); done = false;
 const kept = patient.acquire(() => {}).then(() => { done = true; });
 await new Promise(resolve => setTimeout(resolve, 150)); expect(done).toBe(false); expect(JSON.parse(fs.readFileSync(f.lock, 'utf8')).id).toBe('old-live-holder');
 fs.unlinkSync(f.lock); await kept; await patient.release();
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

it.each(['in-place', 'rename'])('a %s save during our write is caught by the immediate pre-rename check: conflict, nothing written, no sync IO', async (kind) => {
 const f = fixture(), open = fs.promises.open.bind(fs.promises), syncStat = vi.spyOn(fs, 'lstatSync'), saved = { ...f.original, model: `operator-${kind}` };
 let injected = false;
 vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
  const handle = await open(...args), file = String(args[0]);
  if (!injected && file.startsWith(`${f.settings}.`) && file.endsWith('.tmp')) {
   injected = true;
   if (kind === 'in-place') fs.writeFileSync(f.settings, JSON.stringify(saved));
   else { fs.writeFileSync(`${f.settings}.editor`, JSON.stringify(saved)); fs.renameSync(`${f.settings}.editor`, f.settings); }
  }
  return handle;
 });
 const a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot);
 await expect(a.acquire(() => {})).rejects.toThrow('changed'); expect(injected).toBe(true); expect(f.read()).toEqual(saved);
 expect(syncStat.mock.calls.filter(([file]) => String(file).startsWith(f.root))).toEqual([]);
 expect(fs.readdirSync(path.dirname(f.settings))).toEqual(['settings.json']);
 await a.release(); expect(f.read()).toEqual(saved); expect(fs.readdirSync(f.ledgerRoot)).toEqual([]);
});
it('binds the receipt to its own intent snapshot and never overwrites a foreign ledger write', async () => {
 const f = fixture(), rename = fs.promises.rename.bind(fs.promises);
 vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
  await rename(from, to);
  if (to === f.settings) { const record = JSON.parse(fs.readFileSync(f.ledger, 'utf8')); record.groups[0].owners.push({ id: 'foreign-writer', pid: process.ppid, count: 1 }); fs.writeFileSync(f.ledger, JSON.stringify(record)); }
 });
 await expect(createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot).acquire(() => {})).rejects.toThrow('changed');
 expect(JSON.parse(fs.readFileSync(f.ledger, 'utf8')).groups[0].owners.map((owner: { id: string }) => owner.id)).toContain('foreign-writer');
});
it('removes at most its own occurrence when the operator added an identical copy', async () => {
 const f = fixture(), a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {});
 const document = f.read(); document.hooks.PreToolUse.push(structuredClone(hook)); fs.writeFileSync(f.settings, JSON.stringify(document));
 await a.release(); expect(f.read().hooks.PreToolUse).toEqual([hook]); expect(f.read().hooks.Stop).toEqual([{ own: true }]);
});
it('refuses PreToolUse null before any publication', async () => {
 const f = fixture(), raw = JSON.stringify({ ...f.original, hooks: { PreToolUse: null } }); fs.writeFileSync(f.settings, raw);
 await expect(createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot).acquire(() => {})).rejects.toThrow('hooks_invalid');
 expect(fs.readFileSync(f.settings, 'utf8')).toBe(raw); expect(fs.existsSync(f.ledger)).toBe(false);
});
it('startup recovery never waits for a held lock: it is retained, untouched, in a single try', async () => {
 const f = fixture(), a = createMuseNativeHeavySettingsLease(f.settings, hook, f.artifactRoot); await a.acquire(() => {});
 const record = JSON.parse(fs.readFileSync(f.ledger, 'utf8')); record.groups[0].owners[0].pid = 2147483647; fs.writeFileSync(f.ledger, JSON.stringify(record));
 fs.writeFileSync(f.lock, JSON.stringify({ pid: process.ppid, id: 'live-holder' }));
 const started = performance.now();
 expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 0, retained: 1, failed: 0 });
 expect(performance.now() - started).toBeLessThan(250);
 expect(fs.readFileSync(f.lock, 'utf8')).toContain('live-holder'); expect(f.read().hooks.PreToolUse).toEqual([hook]);
 fs.unlinkSync(f.lock); expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 1, retained: 0, failed: 0 });
});

// Real cross-process control: separate Node processes share only the files.
const CHILD = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const [bundle, settings, artifactRoot, ledger, mode, rounds] = process.argv.slice(2);
if (mode.startsWith('crash-')) { // a real SIGKILL just before or just after the settings commit
  const fsp = fs.promises;
  for (const name of ['rename', 'link']) { const commit = fsp[name].bind(fsp); fsp[name] = async (from, to) => { if (to === settings && mode === 'crash-before') process.kill(process.pid, 'SIGKILL'); await commit(from, to); if (to === settings && mode === 'crash-after') process.kill(process.pid, 'SIGKILL'); }; }
}
const { createMuseNativeHeavySettingsLease: lease } = require(bundle); const hook = JSON.parse(process.env.LEASE_HOOK);
const has = () => (JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.PreToolUse ?? []).some(entry => JSON.stringify(entry) === JSON.stringify(hook));
process.on('message', async () => {
  try {
    if (mode === 'hold') { await lease(settings, hook, artifactRoot).acquire(() => {}); process.send({ held: true }); return; }
    if (mode.startsWith('crash-')) { await lease(settings, hook, artifactRoot).acquire(() => {}); process.send({ survived: true }); return; }
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
it.each([['crash-before', true], ['crash-after', true], ['crash-after', false]] as const)('a real Main killed at %s the settings commit (existing=%s) leaves the operator settings or ours, never neither, and recovery restores', async (mode, existing) => {
 const f = fixture(), bundle = path.join(f.root, 'lease.cjs'), child = path.join(f.root, 'child.cjs');
 if (!existing) fs.unlinkSync(f.settings);
 const original = existing ? fs.readFileSync(f.settings, 'utf8') : undefined, expected = existing ? f.original : {};
 await build({ entryPoints: [path.join(process.cwd(), 'src/main/orch/native-heavy-muse-lease.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
 fs.writeFileSync(child, CHILD);
 const proc = fork(child, [bundle, f.settings, f.artifactRoot, f.ledger, mode, '1'], { execArgv: [], env: { PATH: '/usr/bin:/bin', HOME: f.root, LEASE_HOOK: JSON.stringify(hook) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
 const exited = new Promise<NodeJS.Signals | null>(resolve => proc.once('exit', (_code, signal) => resolve(signal)));
 proc.send('go'); expect(await exited).toBe('SIGKILL');
 if (mode === 'crash-before') expect(fs.readFileSync(f.settings, 'utf8')).toBe(original); // operator bytes untouched
 else expect(f.read()).toEqual(existing ? { ...f.original, hooks: { ...f.original.hooks, PreToolUse: [hook] } } : { hooks: { PreToolUse: [hook] } }); // ours = theirs + the entry
 expect(fs.statSync(f.settings).nlink).toBe(1); // no second name pins the operator file
 for (const name of fs.readdirSync(path.dirname(f.settings)).filter(name => name !== 'settings.json')) {
  expect(name).toMatch(/^settings\.json\.[0-9a-f]+\.tmp$/); expect(fs.readFileSync(path.join(path.dirname(f.settings), name), 'utf8')).toContain('NEXUS_HEAVY_MUSE_LEASE_V1=1 ');
 }
 expect(await recoverMuseNativeHeavyLeases({ artifactRoot: f.artifactRoot })).toEqual({ restored: 1, retained: 0, failed: 0 });
 expect(f.read()).toEqual(expected);
 // Only the dead Main's own prepared lock owner may remain (our file, never operator data).
 for (const name of fs.readdirSync(f.ledgerRoot)) { expect(name).toMatch(new RegExp(`^${f.key}\\.lock\\.[0-9a-f-]{36}\\.owner$`)); expect(JSON.parse(fs.readFileSync(path.join(f.ledgerRoot, name), 'utf8')).pid).toBe(proc.pid); }
}, 30_000);
