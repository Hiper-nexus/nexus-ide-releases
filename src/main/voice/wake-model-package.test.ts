import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EI_JARVIS_PTBR_ONNX_B64,
  EI_JARVIS_PTBR_ONNX_SHA256,
} from './wake-models-ptbr';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const WAKE_RESOURCE_DIR = path.join(ROOT, 'resources', 'wake');

describe('required PT-BR wake release package', () => {
  it('pins one default model identically in the resource, manifest and embedded fallback', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(WAKE_RESOURCE_DIR, 'manifest.json'),
      'utf8',
    )) as {
      schemaVersion: number;
      defaultModel: {
        file: string;
        locale: string;
        required: boolean;
        sha256: string;
        wakePhrase: string;
      };
    };
    const resource = fs.readFileSync(path.join(
      WAKE_RESOURCE_DIR,
      manifest.defaultModel.file,
    ));
    const embedded = Buffer.from(EI_JARVIS_PTBR_ONNX_B64, 'base64');
    const resourceHash = createHash('sha256').update(resource).digest('hex');
    const embeddedHash = createHash('sha256').update(embedded).digest('hex');

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      defaultModel: {
        file: 'ei-jarvis-ptbr.onnx',
        locale: 'pt-BR',
        required: true,
        sha256: EI_JARVIS_PTBR_ONNX_SHA256,
        wakePhrase: 'Ei Jarvis',
      },
    });
    expect(resourceHash).toBe(EI_JARVIS_PTBR_ONNX_SHA256);
    expect(embeddedHash).toBe(resourceHash);
  });
});
