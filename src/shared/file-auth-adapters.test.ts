import { describe, expect, it } from 'vitest';
import {
  FILE_AUTH_ADAPTER_IDS,
  isFileAuthAdapter,
} from './file-auth-adapters';

describe('file-auth adapter guard', () => {
  it('accepts exactly the canonical adapter IDs', () => {
    for (const adapterId of FILE_AUTH_ADAPTER_IDS) {
      expect(isFileAuthAdapter(adapterId), adapterId).toBe(true);
    }
  });

  it('rejects inherited object property names and unknown providers', () => {
    for (const adapterId of [
      'toString',
      'constructor',
      '__proto__',
      'claude',
      'unknown',
    ]) {
      expect(isFileAuthAdapter(adapterId), adapterId).toBe(false);
    }
  });
});
