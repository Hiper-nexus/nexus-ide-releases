import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_ONNX_B64,
  HEY_JARVIS_ONNX_B64,
  MELSPEC_ONNX_B64,
} from './wake-models';

function sha256Base64(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
}

describe('commercially distributable wake models', () => {
  it('pins the Apache-2.0 SpeechKit/openWakeWord artifacts by checksum', () => {
    expect(sha256Base64(MELSPEC_ONNX_B64)).toBe(
      'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f',
    );
    expect(sha256Base64(EMBEDDING_ONNX_B64)).toBe(
      '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f',
    );
    expect(sha256Base64(HEY_JARVIS_ONNX_B64)).toBe(
      '7256019a18029c7bea33abc3344f7a3d0e07655cf4a5f18e65c9b6329eac3fb6',
    );
  });
});
