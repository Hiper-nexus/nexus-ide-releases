import { describe, expect, it, vi } from 'vitest';
import { LazyWasmAecProcessor, WasmAecProcessor } from './aec-wasm-processor';

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

describe('LazyWasmAecProcessor', () => {
  function fakeProcessor() {
    return {
      capture: vi.fn((samples: Int16Array, sink: (processed: Int16Array) => void) => sink(samples)),
      render24k: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    } as unknown as WasmAecProcessor & {
      capture: ReturnType<typeof vi.fn>;
      render24k: ReturnType<typeof vi.fn>;
      reset: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    };
  }

  it('does not build the AEC3 instance until audio flows', () => {
    const create = vi.fn(fakeProcessor);
    const lazy = new LazyWasmAecProcessor(create);
    lazy.reset();
    expect(create).not.toHaveBeenCalled();
    lazy.dispose();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the processor once on the first frame and forwards to it', () => {
    const inner = fakeProcessor();
    const create = vi.fn(() => inner);
    const lazy = new LazyWasmAecProcessor(create);
    const sink = vi.fn();
    const input = new Int16Array(160).fill(7);
    lazy.capture(input, sink);
    lazy.render24k(new Int16Array(240));
    lazy.capture(input, sink);
    expect(create).toHaveBeenCalledTimes(1);
    expect(inner.capture).toHaveBeenCalledTimes(2);
    expect(inner.render24k).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(input);
    lazy.dispose();
    expect(inner.dispose).toHaveBeenCalledTimes(1);
  });

  it('passes audio through untouched after dispose, without recreating', () => {
    const create = vi.fn(fakeProcessor);
    const lazy = new LazyWasmAecProcessor(create);
    lazy.dispose();
    const sink = vi.fn();
    const input = new Int16Array(160).fill(3);
    lazy.capture(input, sink);
    lazy.render24k(new Int16Array(240));
    expect(sink).toHaveBeenCalledWith(input);
    expect(create).not.toHaveBeenCalled();
  });
});
