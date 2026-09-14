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
  const linuxX64 = path.join(runtimeRoot, 'linux/x64');
  writeFileSync(path.join(linuxX64, 'libonnxruntime.so'), 'cpu');
  writeFileSync(path.join(linuxX64, 'libonnxruntime_providers_cuda.so'), 'gpu');
  writeFileSync(path.join(linuxX64, 'libonnxruntime_providers_tensorrt.so'), 'gpu');
  writeFileSync(path.join(linuxX64, 'libonnxruntime_providers_shared.so'), 'gpu');
  for (const language of ['eng', 'por']) {
    for (const dataset of ['4.0.0', '4.0.0_best_int']) {
      const dir = path.join(
        root,
        'node_modules',
        '@tesseract.js-data',
        language,
        dataset,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${language}.traineddata.gz`), dataset);
    }
  }
  return root;
}

describe('pruneNativePayload', () => {
  it('keeps only the packaged macOS ARM64 ONNX runtime', () => {
    const root = fixture();

    const removed = pruneNativePayload(root, 'darwin', 'arm64');

    expect(removed).toEqual(
      expect.arrayContaining([
        path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'linux'),
        path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32'),
        path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'darwin', 'x64'),
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
      path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'darwin', 'x64'),
    );
  });

  it('removes GPU provider libraries from the CPU-only Linux package', () => {
    const root = fixture();
    const removed = pruneNativePayload(root, 'linux', 'x64');
    const prefix = path.join(
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v3',
      'linux',
      'x64',
    );

    expect(removed).toEqual(
      expect.arrayContaining([
        path.join(prefix, 'libonnxruntime_providers_cuda.so'),
        path.join(prefix, 'libonnxruntime_providers_tensorrt.so'),
        path.join(prefix, 'libonnxruntime_providers_shared.so'),
      ]),
    );
    expect(() =>
      writeFileSync(
        path.join(root, prefix, 'libonnxruntime.so'),
        'cpu-still-present',
      ),
    ).not.toThrow();
  });

  it('keeps only the pinned compact OCR dataset used by the runtime', () => {
    const root = fixture();
    const removed = pruneNativePayload(root, 'darwin', 'arm64');

    expect(removed).toEqual(
      expect.arrayContaining([
        path.join('node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
        path.join('node_modules', '@tesseract.js-data', 'por', '4.0.0'),
      ]),
    );
    for (const language of ['eng', 'por']) {
      expect(() =>
        writeFileSync(
          path.join(
            root,
            'node_modules/@tesseract.js-data',
            language,
            '4.0.0_best_int',
            `${language}.traineddata.gz`,
          ),
          'still-present',
        ),
      ).not.toThrow();
    }
  });
});
