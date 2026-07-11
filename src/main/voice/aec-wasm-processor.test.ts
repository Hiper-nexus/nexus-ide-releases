import { describe, expect, it, vi } from 'vitest';
import { WasmAecProcessor } from './aec-wasm-processor';

async function ready(processor: WasmAecProcessor): Promise<void> {
  await vi.waitFor(() => expect(processor.isReady).toBe(true));
}

describe('WasmAecProcessor', () => {
  it('loads the real AEC3 wasm and returns finite 16k PCM', async () => {
    const processor = new WasmAecProcessor();
    await ready(processor);
    processor.render24k(new Int16Array(240).fill(500));
    const sink = vi.fn();
    processor.capture(new Int16Array(160).fill(500), sink);
    expect(sink).toHaveBeenCalledTimes(1);
    const output = sink.mock.calls[0][0] as Int16Array;
    expect(output.length).toBe(160);
    expect(Array.from(output).every(Number.isFinite)).toBe(true);
    processor.dispose();
  });

  it('fails open while wasm is still initializing', () => {
    const processor = new WasmAecProcessor();
    const input = new Int16Array(160).fill(3);
    const sink = vi.fn();
    processor.capture(input, sink);
    expect(sink).toHaveBeenCalledWith(input);
    processor.dispose();
  });
});
