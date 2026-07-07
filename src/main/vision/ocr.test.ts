import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock tesseract.js
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(),
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
    expect(createWorker).toHaveBeenCalledWith('eng', 1, expect.any(Object));
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

    const buffer = Buffer.from('same-image');
    const result1 = await ocrImage(buffer);
    const result2 = await ocrImage(buffer);

    expect(result1.text).toBe('Cached');
    expect(result2.text).toBe('Cached');
    // Should only create worker once (cached second call)
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('throws on OCR failure', async () => {
    vi.mocked(createWorker).mockRejectedValue(new Error('Worker init failed'));

    const buffer = Buffer.from('bad-image');
    await expect(ocrImage(buffer)).rejects.toThrow('OCR failed: Worker init failed');
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
});
