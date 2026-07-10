import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface TestProcessor {
  port: { postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][]): boolean;
}

function loadProcessor(): new () => TestProcessor {
  const source = fs.readFileSync(
    path.join(__dirname, 'pcm-processor.js'),
    'utf8',
  );
  let registered: (new () => TestProcessor) | null = null;

  class AudioWorkletProcessorStub {
    port = { postMessage: vi.fn() };
  }

  vm.runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Float32Array,
    registerProcessor: (
      name: string,
      processor: new () => TestProcessor,
    ) => {
      expect(name).toBe('nexus-pcm-processor');
      registered = processor;
    },
  });

  if (!registered) throw new Error('processor was not registered');
  return registered;
}

describe('nexus PCM AudioWorklet', () => {
  it('downmixes and batches five 128-sample quanta into one 40ms frame', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const left = new Float32Array(128).fill(1);
    const right = new Float32Array(128).fill(3);

    for (let i = 0; i < 4; i += 1) {
      expect(processor.process([[left, right]])).toBe(true);
    }
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    expect(processor.process([[left, right]])).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    const frame = processor.port.postMessage.mock.calls[0][0] as Float32Array;
    expect(frame).toHaveLength(640);
    expect(Array.from(frame)).toEqual(new Array(640).fill(2));
  });
});
