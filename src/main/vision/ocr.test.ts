import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock tesseract.js
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(),
}));
vi.mock('./ocr-language-data', () => ({
  ensureOcrLanguageData: vi.fn(async () => '/tmp/nexus-ocr-languages'),
}));

import { createWorker } from 'tesseract.js';
import { clearOcrCache, ocrImage } from './ocr';

const KNOWN_TEXT = 'HELLO VISION';
const KNOWN_TEXT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('ocrImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOcrCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearOcrCache();
  });

  it('extracts known fixture text through the local OCR pipeline', async () => {
    const mockWorker = {
      recognize: vi.fn().mockResolvedValue({
        data: { text: `${KNOWN_TEXT}\n`, confidence: 85 },
      }),
      terminate: vi.fn(),
    };
    vi.mocked(createWorker).mockResolvedValue(mockWorker as any);

    const result = await ocrImage(KNOWN_TEXT_PNG, 'eng');

    expect(result.text).toBe(KNOWN_TEXT);
    expect(result.confidence).toBe(85);
    expect(createWorker).toHaveBeenCalledWith(
      'eng',
      1,
      expect.objectContaining({
        workerPath: expect.stringMatching(/tesseract\.js[/\\]src[/\\]worker-script[/\\]node[/\\]index\.js$/),
        langPath: '/tmp/nexus-ocr-languages',
        cachePath: '/tmp/nexus-ocr-languages',
        cacheMethod: 'none',
        gzip: true,
      }),
    );
    expect(mockWorker.recognize).toHaveBeenCalledWith(KNOWN_TEXT_PNG);
    expect(mockWorker.terminate).toHaveBeenCalled();
  });

  it('returns cached result for same image within 30s', async () => {
    const mockWorker = {
      recognize: vi.fn().mockResolvedValue({
        data: { text: 'Cached\n', confidence: 90 },
      }),
      terminate: vi.fn(),
    };
    vi.mocked(createWorker).mockResolvedValue(mockWorker as any);

    const result1 = await ocrImage(KNOWN_TEXT_PNG);
    const result2 = await ocrImage(KNOWN_TEXT_PNG);

    expect(result1.text).toBe('Cached');
    expect(result2.text).toBe('Cached');
    // Should only create worker once (cached second call)
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('throws on OCR failure', async () => {
    vi.mocked(createWorker).mockRejectedValue(new Error('Worker init failed'));

    await expect(ocrImage(KNOWN_TEXT_PNG)).rejects.toThrow(
      'OCR failed: Worker init failed',
    );
  });

  it('terminates the worker when recognition fails', async () => {
    const mockWorker = {
      recognize: vi.fn().mockRejectedValue(new Error('bad pixels')),
      terminate: vi.fn(),
    };
    vi.mocked(createWorker).mockResolvedValue(mockWorker as any);

    await expect(ocrImage(KNOWN_TEXT_PNG)).rejects.toThrow('OCR failed: bad pixels');
    expect(mockWorker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects invalid PNG buffers before creating a worker', async () => {
    await expect(ocrImage(Buffer.from('not-a-png'))).rejects.toThrow(
      'valid PNG',
    );
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects non-vendored languages without attempting a network fallback', async () => {
    await expect(ocrImage(KNOWN_TEXT_PNG, 'fra')).rejects.toThrow(
      'Unsupported OCR language',
    );
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects buffers larger than the configured byte limit', async () => {
    const originalLimit = process.env.VISION_OCR_MAX_BYTES;
    process.env.VISION_OCR_MAX_BYTES = '16';
    const oversizedPng = Buffer.concat([KNOWN_TEXT_PNG, Buffer.alloc(17)]);

    try {
      await expect(ocrImage(oversizedPng)).rejects.toThrow('exceeds 16 bytes');
      expect(createWorker).not.toHaveBeenCalled();
    } finally {
      if (originalLimit === undefined) {
        Reflect.deleteProperty(process.env, 'VISION_OCR_MAX_BYTES');
      } else {
        process.env.VISION_OCR_MAX_BYTES = originalLimit;
      }
    }
  });

  it('times out recognition and terminates the worker', async () => {
    vi.useFakeTimers();
    const mockWorker = {
      recognize: vi.fn(() => new Promise(() => undefined)),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createWorker).mockResolvedValue(mockWorker as any);

    const result = ocrImage(KNOWN_TEXT_PNG);
    const rejection = result.then(
      () => null,
      (err: unknown) => err,
    );

    await vi.waitFor(() => {
      expect(mockWorker.recognize).toHaveBeenCalledOnce();
    });
    expect(mockWorker.recognize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);

    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('OCR timed out after 30000ms');
    expect(mockWorker.terminate).toHaveBeenCalledOnce();
  });
});
