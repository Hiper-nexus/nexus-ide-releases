import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearOcrCache, ocrImage } from './ocr';

const OCR_INTEGRATION_TIMEOUT_MS = 60_000;
const previousOcrTimeout = process.env.VISION_OCR_TIMEOUT_MS;

let runtimeRoot = '';
let previousRuntimeRoot: string | undefined;

beforeAll(async () => {
  previousRuntimeRoot = process.env.NEXUS_USER_DATA_DIR;
  runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-ocr-offline-'));
  process.env.NEXUS_USER_DATA_DIR = runtimeRoot;
  // Shared CI runners can take longer to initialize tesseract than a local
  // desktop. Keep production's 30s fail-fast default; widen only this real
  // vendored-data integration probe.
  process.env.VISION_OCR_TIMEOUT_MS = '90000';
});

afterAll(async () => {
  clearOcrCache();
  if (previousRuntimeRoot === undefined) {
    Reflect.deleteProperty(process.env, 'NEXUS_USER_DATA_DIR');
  } else {
    process.env.NEXUS_USER_DATA_DIR = previousRuntimeRoot;
  }
  if (previousOcrTimeout === undefined) {
    Reflect.deleteProperty(process.env, 'VISION_OCR_TIMEOUT_MS');
  } else {
    process.env.VISION_OCR_TIMEOUT_MS = previousOcrTimeout;
  }
  await rm(runtimeRoot, { recursive: true, force: true });
});

describe('offline packaged OCR', () => {
  it(
    'recognizes a real Nexus screenshot using only vendored eng/por data',
    async () => {
      const screenshot = await readFile(
        path.resolve(
          'docs/analysis/local-voice-benchmark-2026-07-07/screenshots/04-nexus-canvas-current.png',
        ),
      );

      const result = await ocrImage(screenshot, 'eng+por');

      expect(result.text).toMatch(/NexusIDE/i);
      expect(result.confidence).toBeGreaterThan(0);
    },
    OCR_INTEGRATION_TIMEOUT_MS,
  );
});
