import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AecLiveProcessor } from './aec-live-processor';

class Client extends EventEmitter {
  isReady = true;
  offerCapture = vi.fn(() => true);
  offerRender = vi.fn(() => true);
}

describe('AecLiveProcessor', () => {
  it('routes processed frames to the capture owner', () => {
    const client = new Client();
    const processor = new AecLiveProcessor(client as never);
    const sink = vi.fn();
    processor.capture(new Int16Array(160), sink);
    client.emit('processed', new Int16Array(160).fill(9));
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ length: 160 }));
  });

  it('drops late processed frames after generation reset', () => {
    const client = new Client();
    const processor = new AecLiveProcessor(client as never);
    const sink = vi.fn();
    processor.capture(new Int16Array(160), sink);
    processor.reset();
    client.emit('processed', new Int16Array(160));
    expect(sink).not.toHaveBeenCalled();
  });

  it('fails open when native helper is not ready', () => {
    const client = new Client();
    client.isReady = false;
    const processor = new AecLiveProcessor(client as never);
    const sink = vi.fn();
    const original = new Int16Array(320);
    processor.capture(original, sink);
    expect(sink).toHaveBeenCalledWith(original);
  });

  it('feeds 24k provider output as 16k render frames', () => {
    const client = new Client();
    const processor = new AecLiveProcessor(client as never);
    processor.render24k(new Int16Array(480));
    expect(client.offerRender).toHaveBeenCalledTimes(2);
  });
});
