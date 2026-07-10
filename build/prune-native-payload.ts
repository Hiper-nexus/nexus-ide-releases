import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ONNX_PLATFORM_DIRS = new Set(['darwin', 'linux', 'win32']);
const ONNX_ARCH_DIRS = new Set(['arm64', 'x64']);

export function pruneNativePayload(
  buildPath: string,
  platform: string,
  arch: string,
): string[] {
  const runtimeRoot = path.join(
    buildPath,
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v3',
  );
  if (!existsSync(runtimeRoot) || !ONNX_PLATFORM_DIRS.has(platform)) return [];

  const removed: string[] = [];
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
  return removed;
}
