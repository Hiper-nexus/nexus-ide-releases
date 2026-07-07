import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock tesseract.js
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(),
}));

import { createWorker } from 'tesseract.js';
import { ocrImage } from './ocr';

describe('ocrImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs OCR on a PNG buffer and returns text', async () => {
    const mockWorker = {
      recognize: vi.fn().mockResolvedValue({
        data: { text: 'Hello World\n', confidence: 85 },
      }),
      terminate: vi.fn(),
    };
    vi.mocked(createWorker).mockResolvedValue(mockWorker as any);

    const buffer = Buffer.from('fake-png-data');
    const result = await ocrImage(buffer, 'eng');

    expect(result.text).toBe('Hello World');
    expect(result.confidence).toBe(85);
    expect(createWorker).toHaveBeenCalledWith('eng', 1, expect.any(Object));
    expect(mockWorker.recognize).toHaveBeenCalledWith(buffer);
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
});