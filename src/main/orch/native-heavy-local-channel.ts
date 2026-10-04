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
const TRANSPORT_DOMAIN = 'nexus.native-heavy-transport/v1';
export type NativeHeavyTransport = 'unix' | 'file';
export interface HeavyChannelChild {
  on(event: 'message', callback: (message: unknown) => void): unknown;
  on(event: 'exit', callback: (code: number | null) => void): unknown;
  postMessage(message: unknown): void;
  kill(): unknown;
}
export interface HeavyLocalChannelPorts {
  spawn(entry: string, cwd: string, transport?: NativeHeavyTransport): HeavyChannelChild;
  current(ctx: AgentGateContext): boolean;
  admit(ctx: AgentGateContext, body: unknown, signal: AbortSignal): Promise<{ allow: boolean; reason?: string; leaseId?: string }>;
  drainContext?(ctx: AgentGateContext): Promise<void>;
}
const production: HeavyLocalChannelPorts = {
  spawn: (entry, cwd, transport = 'unix') => utilityProcess.fork(entry, transport === 'file' ? ['--file'] : [], { cwd, serviceName: 'Nexus native admission channel', stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' } }),
  current: isCurrentGateContext, admit: (ctx, body, signal) => nativeHeavyCommands.admit(ctx, body, signal), drainContext: ctx => nativeHeavyCommands.drainContext(ctx),
};
export interface NativeHeavyLocalChannel { readonly transport: NativeHeavyTransport; readonly env: Readonly<Record<string, string>>; dispose(): Promise<void> }
const channels = new Set<NativeHeavyLocalChannel>();
export async function createNativeHeavyLocalChannel(ctx: AgentGateContext, privateTmp: string, ports: HeavyLocalChannelPorts = production, options: { transport?: NativeHeavyTransport } = {}): Promise<NativeHeavyLocalChannel> {
  const transport = options.transport ?? 'unix';
  if (transport !== 'unix' && transport !== 'file') throw new Error('native_heavy_channel_transport_invalid');
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
  const ownedFiles = new Map<string, { dev: number; ino: number }>();
  const remember = (name: string, stat: { dev: number; ino: number }) => ownedFiles.set(name, { dev: stat.dev, ino: stat.ino });
  const revoked = () => { accepting = false; for (const request of pending.values()) request.controller.abort(); };
  const expired = () => { revoked(); if (initialized) void channel.dispose().catch(() => console.warn('[native-heavy] channel cleanup remains pending')); };
  parent?.addEventListener('abort', expired, { once: true });
  const receive = (message: unknown) => {
    if (typeof message !== 'object' || !message) return;
    const value = message as { type?: string; id?: string; raw?: string; transport?: string; slot?: number; identity?: { dev?: number; ino?: number }; responses?: Array<{ name: string; dev: number; ino: number }> };
    if (value.type === 'ready') {
      try {
        if (transport === 'unix') { const socket = fs.lstatSync(path.join(directory, 'heavy.sock')); if (!socket.isSocket()) throw new Error('invalid socket'); socketIdentity = { dev: socket.dev, ino: socket.ino }; }
        else {
          if (value.transport !== 'file' || value.responses?.length !== 16) throw new Error('invalid file endpoint');
          for (let slot = 0; slot < 16; slot++) { const expected = ownedFiles.get(`response-${String(slot).padStart(2, '0')}.json`), actual = value.responses[slot]; if (!expected || actual.name !== `response-${String(slot).padStart(2, '0')}.json` || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('changed file endpoint'); }
        }
        settleReady(true);
      }
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
    if (!timingSafeEqual(expected, Buffer.from(packet.mac, 'hex'))) return;
    if (!accepting || !ports.current(ctx) || replay.size >= 4096 || Math.abs(now - packet.issuedAt) > 30000 || replay.has(packet.id)) return;
    if (transport === 'file') {
      if (!Number.isInteger(value.slot) || value.slot! < 0 || value.slot! >= 16 || !Number.isSafeInteger(value.identity?.dev) || !Number.isSafeInteger(value.identity?.ino)) return;
      remember(`request-${String(value.slot).padStart(2, '0')}.json`, { dev: value.identity!.dev!, ino: value.identity!.ino! });
    }
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
    transport,
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
        if (transport === 'unix') {
          const socket = path.join(directory, 'heavy.sock');
          try { const stat = await fsp.lstat(socket); if (!stat.isSocket() || !socketIdentity || stat.dev !== socketIdentity.dev || stat.ino !== socketIdentity.ino) throw new Error('native_heavy_channel_socket_changed'); await fsp.unlink(socket); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        for (const [name, identity] of ownedFiles) {
          const file = path.join(directory, name);
          try { const stat = await fsp.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('native_heavy_channel_file_changed'); await fsp.unlink(file); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        await fsp.rmdir(directory); closed = true; channels.delete(channel); parent?.removeEventListener('abort', expired);
      })();
      void disposePending.finally(() => disposePending = undefined).catch(() => {}); return disposePending;
    },
  };
  channels.add(channel);
  try {
    assertCurrent(); await fsp.chmod(directory, 0o700); assertCurrent();
    const manifest = { schema: TRANSPORT_DOMAIN, epoch, directory, transport, slots: 16,
      signature: sign(null, Buffer.from(JSON.stringify([TRANSPORT_DOMAIN, epoch, directory, transport, 16])), privateKey).toString('base64') };
    const createFile = async (name: string, bytes: string) => {
      assertCurrent(); const file = await fsp.open(path.join(directory, name), 'wx', 0o600);
      try { remember(name, fs.fstatSync(file.fd)); assertCurrent(); await file.writeFile(bytes); assertCurrent(); } finally { await file.close(); }
    };
    await createFile('transport.json', JSON.stringify(manifest)); assertCurrent();
    if (transport === 'file') for (let slot = 0; slot < 16; slot++) { await createFile(`response-${String(slot).padStart(2, '0')}.json`, ''); assertCurrent(); }
    child = ports.spawn(entry, directory, transport);
    child.on('exit', () => { exited = true; revoked(); settleReady(false); finishExit(); }); child.on('message', receive);
    if (parent?.aborted) revoked(); assertCurrent();
    timer = setTimeout(() => settleReady(false), 2000);
    const readyResult = await ready; clearTimeout(timer); assertCurrent();
    if (!readyResult || exited || transport === 'unix' && !socketIdentity) throw new Error('native_heavy_channel_start_failed');
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
