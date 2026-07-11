import { describe, expect, it, vi } from 'vitest';
import { AecHelperClient, type AecHelperTransport } from './aec-helper-client';
import { encodeAecFrame } from './aec-protocol';

function fakeTransport() {
  let data: ((chunk: Buffer) => void) | undefined;
  let exit: ((error?: Error) => void) | undefined;
  const transport: AecHelperTransport = {
    write: vi.fn(() => true), close: vi.fn(),
    onData: (listener) => { data = listener; return () => { data = undefined; }; },
    onExit: (listener) => { exit = listener; return () => { exit = undefined; }; },
  };
  return { transport, fireData: (chunk: Buffer) => data?.(chunk), fireExit: () => exit?.() };
}

const runtime = {
  backend: 'wasapi-loopback' as const,
  native: true,
  degraded: false,
  reason: 'available',
  helperPath: '/resources/aec/helper.exe',
};

describe('AecHelperClient', () => {
  it('requires handshake before accepting audio and emits processed frames', () => {
    const fake = fakeTransport();
    const client = new AecHelperClient({ runtime, transport: fake.transport });
    const processed = vi.fn();
    client.on('processed', processed);
    client.start();
    expect(client.offerCapture(new Int16Array(160))).toBe(false);
    fake.fireData(encodeAecFrame({
      type: 2,
      payload: Buffer.from(JSON.stringify({ protocolVersion: 1, ready: true })),
    }));
    expect(client.isReady).toBe(true);
    expect(client.offerCapture(new Int16Array(160))).toBe(true);
    fake.fireData(encodeAecFrame({ type: 5, payload: Buffer.alloc(320) }));
    expect(processed).toHaveBeenCalledWith(expect.any(Int16Array));
    client.stop();
  });

  it('falls back cleanly when no native helper exists', () => {
    const fake = fakeTransport();
    const client = new AecHelperClient({
      runtime: { backend: 'chromium-aec', native: false, degraded: true, reason: 'missing' },
      transport: fake.transport,
    });
    const degraded = vi.fn();
    client.on('degraded', degraded);
    client.start();
    expect(degraded).toHaveBeenCalledWith('missing');
    expect(fake.transport.write).not.toHaveBeenCalled();
  });

  it('counts backpressure drops instead of growing an unbounded queue', () => {
    const fake = fakeTransport();
    vi.mocked(fake.transport.write).mockReturnValue(true);
    const client = new AecHelperClient({ runtime, transport: fake.transport });
    client.start();
    fake.fireData(encodeAecFrame({ type: 2, payload: Buffer.from('{"protocolVersion":1,"ready":true}') }));
    vi.mocked(fake.transport.write).mockReturnValue(false);
    expect(client.offerRender(new Int16Array(160))).toBe(false);
    expect(client.dropped).toBe(1);
    client.stop();
  });
});
