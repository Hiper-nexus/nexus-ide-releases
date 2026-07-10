/**
 * OCR module — Fase 5 Jarvis Vision.
 * Uses tesseract.js for offline, local OCR.
 * Includes a simple cache: same image hash within 30s returns cached result.
 */
import type { OcrResult } from '../../shared/vision-ipc';
import { createHash } from 'node:crypto';
import { ensureOcrLanguageData } from './ocr-language-data';

interface CacheEntry {
  text: string;
  confidence: number;
  cachedAt: number;
}

interface OcrWorker {
  recognize(buffer: Buffer): Promise<{
    data: {
      text: string;
      confidence: number;
    };
  }>;
  terminate(): Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 20;
const OCR_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const SUPPORTED_OCR_LANGUAGES = new Set(['eng', 'por', 'eng+por', 'por+eng']);

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

function maxOcrBytes(): number {
  const parsed = Number.parseInt(process.env.VISION_OCR_MAX_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
  );
}

function validateImage(buffer: Buffer): void {
  const maxBytes = maxOcrBytes();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`OCR image exceeds ${maxBytes} bytes.`);
  }
  if (!isPng(buffer)) {
    throw new Error('OCR image must be a valid PNG.');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`OCR timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pruneCache(): void {
  if (cache.size <= CACHE_MAX_SIZE) return;
  const now = Date.now();
  // Remove expired entries first
  for (const [key, entry] of cache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  // If still too many, remove oldest
  if (cache.size > CACHE_MAX_SIZE) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    for (let i = 0; i < sorted.length - CACHE_MAX_SIZE; i++) {
      cache.delete(sorted[i][0]);
    }
  }
}

export function clearOcrCache(): void {
  cache.clear();
}

/**
 * Run OCR on a PNG image buffer using tesseract.js.
 * @param buffer PNG image buffer
 * @param lang Language code(s) for OCR, e.g. 'eng+por'
 * @returns Recognized text and confidence score
 */
export async function ocrImage(
  buffer: Buffer,
  lang: string = 'eng+por',
): Promise<OcrResult> {
  validateImage(buffer);
  if (!SUPPORTED_OCR_LANGUAGES.has(lang)) {
    throw new Error(`Unsupported OCR language: ${lang}.`);
  }

  // Check cache
  const hash = hashBuffer(buffer);
  const cached = cache.get(hash);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { text: cached.text, confidence: cached.confidence };
  }

  // Dynamic import tesseract (it's heavy, only load on first use)
  const languageDirectory = await ensureOcrLanguageData();
  const { createWorker } = await import('tesseract.js');
  let worker: OcrWorker | null = null;

  try {
    worker = await createWorker(lang, 1, {
      langPath: languageDirectory,
      cachePath: languageDirectory,
      cacheMethod: 'none',
      gzip: true,
      logger: () => {
        // Silent — no progress logging
      },
    }) as OcrWorker;

    const {
      data: { text, confidence },
    } = await withTimeout(worker.recognize(buffer), OCR_TIMEOUT_MS);

    const result: OcrResult = {
      text: text.trim(),
      confidence: Math.round(confidence),
    };

    // Cache result
    cache.set(hash, { ...result, cachedAt: Date.now() });
    pruneCache();

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OCR failed: ${message}`);
  } finally {
    if (worker) {
      await Promise.resolve(worker.terminate()).catch(() => undefined);
    }
  }
}
