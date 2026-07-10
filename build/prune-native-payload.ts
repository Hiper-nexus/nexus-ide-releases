import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ONNX_PLATFORM_DIRS = new Set(['darwin', 'linux', 'win32']);
const ONNX_ARCH_DIRS = new Set(['arm64', 'x64']);
const LINUX_GPU_PROVIDER =
  /^libonnxruntime_providers_(?:cuda|tensorrt|shared)\.so(?:\.\d+)*$/i;
const OCR_LANGUAGES = ['eng', 'por'] as const;

function removeUnusedOcrDatasets(buildPath: string, removed: string[]): void {
  for (const language of OCR_LANGUAGES) {
    const fullDataset = path.join(
      buildPath,
      'node_modules',
      '@tesseract.js-data',
      language,
      '4.0.0',
    );
    if (!existsSync(fullDataset)) continue;
    rmSync(fullDataset, { recursive: true, force: true });
    removed.push(path.relative(buildPath, fullDataset));
  }
}

function removeLinuxGpuProviders(
  buildPath: string,
  targetPath: string,
  removed: string[],
): void {
  if (!existsSync(targetPath)) return;
  const pending = [targetPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && LINUX_GPU_PROVIDER.test(entry.name)) {
        rmSync(entryPath, { force: true });
        removed.push(path.relative(buildPath, entryPath));
      }
    }
  }
}

export function pruneNativePayload(
  buildPath: string,
  platform: string,
  arch: string,
): string[] {
  const removed: string[] = [];
  removeUnusedOcrDatasets(buildPath, removed);
  const runtimeRoot = path.join(
    buildPath,
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3',
  );
  if (!existsSync(runtimeRoot) || !ONNX_PLATFORM_DIRS.has(platform)) return removed;

  for (const platformEntry of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!platformEntry.isDirectory() || !ONNX_PLATFORM_DIRS.has(platformEntry.name)) {
      continue;
    }
    const platformPath = path.join(runtimeRoot, platformEntry.name);
    if (platformEntry.name !== platform) {
      rmSync(platformPath, { recursive: true, force: true });
      removed.push(path.relative(buildPath, platformPath));
      continue;
    }
    // Universal macOS packages need both slices. Unknown target arches are left
    // intact rather than risking a package with no usable binding.
    if (arch === 'universal' || !ONNX_ARCH_DIRS.has(arch)) continue;
    for (const archEntry of readdirSync(platformPath, { withFileTypes: true })) {
      if (
        archEntry.isDirectory() &&
        ONNX_ARCH_DIRS.has(archEntry.name) &&
        archEntry.name !== arch
      ) {
        const archPath = path.join(platformPath, archEntry.name);
        rmSync(archPath, { recursive: true, force: true });
        removed.push(path.relative(buildPath, archPath));
      }
    }
  }
  if (platform === 'linux' && ONNX_ARCH_DIRS.has(arch)) {
    removeLinuxGpuProviders(
      buildPath,
      path.join(runtimeRoot, platform, arch),
      removed,
    );
  }
  return removed;
}
