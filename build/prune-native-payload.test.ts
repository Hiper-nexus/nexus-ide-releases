import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneNativePayload } from './prune-native-payload';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-native-prune-'));
  roots.push(root);
  const runtimeRoot = path.join(
    root,
    'node_modules/onnxruntime-node/bin/napi-v3',
  );
  for (const target of [
    'darwin/arm64',
    'darwin/x64',
    'linux/arm64',
    'linux/x64',
    'win32/arm64',
    'win32/x64',
  ]) {
    const dir = path.join(runtimeRoot, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'binding.node'), target);
  }
  return root;
}

describe('pruneNativePayload', () => {
  it('keeps only the packaged macOS ARM64 ONNX runtime', () => {
    const root = fixture();

    const removed = pruneNativePayload(root, 'darwin', 'arm64');

    expect(removed).toEqual(
      expect.arrayContaining([
        'node_modules/onnxruntime-node/bin/napi-v3/linux',
        'node_modules/onnxruntime-node/bin/napi-v3/win32',
        'node_modules/onnxruntime-node/bin/napi-v3/darwin/x64',
      ]),
    );
    expect(() =>
      writeFileSync(
        path.join(
          root,
          'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/still-present',
        ),
        'ok',
      ),
    ).not.toThrow();
  });

  it('keeps both macOS architectures for a universal package', () => {
    const root = fixture();
    const removed = pruneNativePayload(root, 'darwin', 'universal');
    expect(removed).not.toContain(
      'node_modules/onnxruntime-node/bin/napi-v3/darwin/x64',
    );
  });
});
