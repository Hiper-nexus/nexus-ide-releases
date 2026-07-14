import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readSource = (file: string) =>
  fs.readFileSync(path.join(__dirname, file), 'utf8');

describe('pcmWorkletBlobUrl', () => {
  const createdBlobs: Blob[] = [];
  const originalCreateObjectURL = URL.createObjectURL;

  beforeEach(() => {
    createdBlobs.length = 0;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return `blob:vitest-${createdBlobs.length}`;
    }) as typeof URL.createObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    vi.resetModules();
  });

  it('uses one CSP-compatible blob URL for the real worklet source', async () => {
    const { PCM_WORKLET_NODE_NAME, pcmWorkletBlobUrl } = await import('./pcm-worklet');
    expect(pcmWorkletBlobUrl()).toMatch(/^blob:/);
    expect(pcmWorkletBlobUrl()).toBe('blob:vitest-1');
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0].type).toBe('text/javascript');
    expect(await createdBlobs[0].text()).toContain(
      `registerProcessor('${PCM_WORKLET_NODE_NAME}'`,
    );
  });

  it('never reintroduces a data URL import in either microphone path', () => {
    expect(readSource('pcm-worklet.ts')).toContain('./pcm-processor.js?raw');
    expect(readSource('voice-capture.ts')).toContain('pcmWorkletBlobUrl');
    expect(readSource('wake-mic.ts')).toContain('pcmWorkletBlobUrl');
  });
});
