import { utilityProcess } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { gateContextAbortSignal, isCurrentGateContext, type AgentGateContext } from './gate';
import { heavyCommandPreloadPath } from './native-heavy-preload';
import { nativeHeavyCommands } from './native-heavy-command';

const schema = z.object({ id: z.uuid(), issuedAt: z.number().int(), body: z.unknown(), mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const DOMAIN = 'nexus.native-heavy-reply/v1';
export interface HeavyChannelChild {
  on(event: 'message', callback: (message: unknown) => void): unknown;
  on(event: 'exit', callback: (code: number | null) => void): unknown;
  postMessage(message: unknown): void;
  kill(): unknown;
}
export interface HeavyLocalChannelPorts {
  spawn(entry: string, cwd: string): HeavyChannelChild;
  current(ctx: AgentGateContext): boolean;
  admit(ctx: AgentGateContext, body: unknown, signal: AbortSignal): Promise<{ allow: boolean; reason?: string; leaseId?: string }>;
  drainContext?(ctx: AgentGateContext): Promise<void>;
}
const production: HeavyLocalChannelPorts = {
  spawn: (entry, cwd) => utilityProcess.fork(entry, [], { cwd, serviceName: 'Nexus native admission channel', stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' } }),
  current: isCurrentGateContext, admit: (ctx, body, signal) => nativeHeavyCommands.admit(ctx, body, signal), drainContext: ctx => nativeHeavyCommands.drainContext(ctx),
};
export interface NativeHeavyLocalChannel { readonly env: Readonly<Record<string, string>>; dispose(): Promise<void> }
const channels = new Set<NativeHeavyLocalChannel>();
export async function createNativeHeavyLocalChannel(ctx: AgentGateContext, privateTmp: string, ports: HeavyLocalChannelPorts = production): Promise<NativeHeavyLocalChannel> {
  const parent = gateContextAbortSignal(ctx);
  const assertCurrent = () => { if (!ports.current(ctx) || parent?.aborted) throw new Error('native_heavy_channel_context_invalid'); };
  assertCurrent(); if (!path.isAbsolute(privateTmp)) throw new Error('native_heavy_channel_context_invalid');
  const entry = path.join(path.dirname(fs.realpathSync(heavyCommandPreloadPath())), 'local-channel.cjs');
  if (fs.realpathSync(entry) !== entry || !fs.statSync(entry).isFile()) throw new Error('native_heavy_channel_resource_invalid');
  const tmp = await fsp.realpath(privateTmp); assertCurrent();
  const tmpStat = await fsp.lstat(tmp); assertCurrent();
  if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) throw new Error('native_heavy_channel_directory_invalid');
  const directory = await fsp.mkdtemp(path.join(tmp, '.nexus-heavy-'));
  const directoryStat = fs.lstatSync(directory);
  const requestKey = randomBytes(32), epoch = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let child: HeavyChannelChild | undefined;
  let exited = false, closed = false, accepting = false, initialized = false, disposePending: Promise<void> | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  let finishExit!: () => void; const physicalExit = new Promise<void>(resolve => finishExit = resolve);
  let settleReady!: (value: boolean) => void; const ready = new Promise<boolean>(resolve => settleReady = resolve);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { controller: AbortController; done: Promise<void> }>(), replay = new Map<string, number>();
  const revoked = () => { accepting = false; for (const request of pending.values()) request.controller.abort(); };
  const expired = () => { revoked(); if (initialized) void channel.dispose().catch(() => console.warn('[native-heavy] channel cleanup remains pending')); };
  parent?.addEventListener('abort', expired, { once: true });
  const receive = (message: unknown) => {
    if (typeof message !== 'object' || !message) return;
    const value = message as { type?: string; id?: string; raw?: string };
    if (value.type === 'ready') {
      try { const socket = fs.lstatSync(path.join(directory, 'heavy.sock')); if (!socket.isSocket()) throw new Error('invalid socket'); socketIdentity = { dev: socket.dev, ino: socket.ino }; settleReady(true); }
      catch { settleReady(false); }
      return;
    }
    if (value.type === 'cancel' && typeof value.id === 'string') { pending.get(value.id)?.controller.abort(); return; }
    if (value.type !== 'request' || typeof value.raw !== 'string' || Buffer.byteLength(value.raw) > 2048 || pending.size >= 16) return;
    let parsed: unknown; try { parsed = JSON.parse(value.raw); } catch { return; }
    const decoded = schema.safeParse(parsed); if (!decoded.success || decoded.data.id !== value.id) return;
    const packet = decoded.data, now = Date.now();
    for (const [id, when] of replay) if (now - when > 30000 && !pending.has(id)) replay.delete(id);
    const input = JSON.stringify([packet.id, packet.issuedAt, packet.body]);
    const expected = createHmac('sha256', requestKey).update(input).digest();
    if (!accepting || !ports.current(ctx) || replay.size >= 4096 || Math.abs(now - packet.issuedAt) > 30000 || replay.has(packet.id) ||
        !timingSafeEqual(expected, Buffer.from(packet.mac, 'hex'))) return;
    replay.set(packet.id, now);
    const controller = new AbortController();
    const done = (async () => {
      let result: { allow: boolean; reason?: string; leaseId?: string } = { allow: false };
      try { result = await ports.admit(ctx, packet.body, controller.signal); } catch { /* signed fail closed */ }
      if (!accepting || !ports.current(ctx) || controller.signal.aborted) result = { allow: false };
      const hash = createHash('sha256').update(input).digest('hex');
      const signed = [DOMAIN, epoch, packet.id, hash, result];
      const raw = JSON.stringify({ schema: DOMAIN, epoch, id: packet.id, hash, result, signature: sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString('base64') });
      if (!exited) { try { child?.postMessage({ type: 'response', id: packet.id, raw }); } catch { controller.abort(); } }
    })().finally(() => pending.delete(packet.id));
    pending.set(packet.id, { controller, done }); void done.catch(() => {});
  };
  const channel: NativeHeavyLocalChannel = {
    env: { NEXUS_HEAVY_CHANNEL_DIR: directory, NEXUS_HEAVY_CHANNEL_KEY: requestKey.toString('hex'), NEXUS_HEAVY_CHANNEL_EPOCH: epoch,
      NEXUS_HEAVY_CHANNEL_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    dispose: () => {
      if (closed) return Promise.resolve();
      if (disposePending) return disposePending;
      disposePending = (async () => {
        revoked();
        await Promise.allSettled([...pending.values()].map(request => request.done));
        await ports.drainContext?.(ctx);
        if (child && !exited) { try { child.postMessage({ type: 'close' }); } catch { child.kill(); } }
        if (child) await physicalExit;
        // This helper executes no work/children. Observed exit ends only its
        // byte channel; it never proves a heavy cohort gone.
        const current = await fsp.lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryStat.dev || current.ino !== directoryStat.ino) throw new Error('native_heavy_channel_directory_changed');
        const socket = path.join(directory, 'heavy.sock');
        try { const stat = await fsp.lstat(socket); if (!stat.isSocket() || !socketIdentity || stat.dev !== socketIdentity.dev || stat.ino !== socketIdentity.ino) throw new Error('native_heavy_channel_socket_changed'); await fsp.unlink(socket); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await fsp.rmdir(directory); closed = true; channels.delete(channel); parent?.removeEventListener('abort', expired);
      })();
      void disposePending.finally(() => disposePending = undefined).catch(() => {}); return disposePending;
    },
  };
  channels.add(channel);
  try {
    assertCurrent(); await fsp.chmod(directory, 0o700); assertCurrent();
    child = ports.spawn(entry, directory);
    child.on('exit', () => { exited = true; revoked(); settleReady(false); finishExit(); }); child.on('message', receive);
    if (parent?.aborted) revoked(); assertCurrent();
    timer = setTimeout(() => settleReady(false), 2000);
    const readyResult = await ready; clearTimeout(timer); assertCurrent();
    if (!readyResult || exited || !socketIdentity) throw new Error('native_heavy_channel_start_failed');
    accepting = true; initialized = true; return channel;
  } catch (error) {
    if (timer) clearTimeout(timer);
    try { await channel.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'native_heavy_channel_setup_cleanup_pending'); }
    throw error;
  }
}
/** Call only after nativeHeavyCommands has obtained its physical drain. */
export async function drainNativeHeavyLocalChannels(): Promise<void> { await Promise.all([...channels].map(channel => channel.dispose())); }
