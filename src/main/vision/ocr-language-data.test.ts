import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureOcrLanguageData,
  OCR_LANGUAGE_ARTIFACTS,
} from './ocr-language-data';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('packaged OCR language data', () => {
  it('pins the npm-packaged eng/por traineddata by SHA-256', async () => {
    for (const artifact of OCR_LANGUAGE_ARTIFACTS) {
      const bytes = await readFile(artifact.sourcePath);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        artifact.sha256,
      );
    }
  });

  it('copies verified language data to one offline runtime directory', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'nexus-ocr-data-'));
    roots.push(target);

    await expect(ensureOcrLanguageData(target)).resolves.toBe(target);
    for (const artifact of OCR_LANGUAGE_ARTIFACTS) {
      const bytes = await readFile(path.join(target, artifact.fileName));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        artifact.sha256,
      );
    }

    await writeFile(path.join(target, 'eng.traineddata.gz'), 'corrupt');
    await ensureOcrLanguageData(target);
    const repaired = await readFile(path.join(target, 'eng.traineddata.gz'));
    expect(createHash('sha256').update(repaired).digest('hex')).toBe(
      OCR_LANGUAGE_ARTIFACTS[0].sha256,
    );
  });
});
