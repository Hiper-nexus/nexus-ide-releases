import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Electron Forge emits the main process as CommonJS. Vite rewrites
// `import.meta.url` to `{}.url` in that bundle, which made createRequire throw
// before the smoke handler or renderer could start. __filename stays absolute
// in both the unpacked and app.asar CommonJS runtimes.
const require = createRequire(__filename);
const DATASET_VERSION = '4.0.0_best_int';

export const OCR_LANGUAGE_ARTIFACTS = Object.freeze([
  Object.freeze({
    fileName: 'eng.traineddata.gz',
    sourcePath: require.resolve(
      `@tesseract.js-data/eng/${DATASET_VERSION}/eng.traineddata.gz`,
    ),
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  }),
  Object.freeze({
    fileName: 'por.traineddata.gz',
    sourcePath: require.resolve(
      `@tesseract.js-data/por/${DATASET_VERSION}/por.traineddata.gz`,
    ),
    sha256: 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c',
  }),
]);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hasExpectedHash(filePath: string, expected: string): Promise<boolean> {
  try {
    return sha256(await readFile(filePath)) === expected;
  } catch {
    return false;
  }
}

async function installArtifact(
  targetDirectory: string,
  artifact: (typeof OCR_LANGUAGE_ARTIFACTS)[number],
): Promise<void> {
  const target = path.join(targetDirectory, artifact.fileName);
  if (await hasExpectedHash(target, artifact.sha256)) return;

  const source = await readFile(artifact.sourcePath);
  if (sha256(source) !== artifact.sha256) {
    throw new Error(`OCR language artifact checksum mismatch: ${artifact.fileName}`);
  }
  const temporary = path.join(
    targetDirectory,
    `.${artifact.fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch {
      await rm(target, { force: true });
      await rename(temporary, target);
    }
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  if (!(await hasExpectedHash(target, artifact.sha256))) {
    throw new Error(`OCR language artifact failed verification: ${artifact.fileName}`);
  }
}

function defaultOcrLanguageDirectory(): string {
  const configuredRoot = process.env.NEXUS_USER_DATA_DIR?.trim();
  const nexusRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(os.homedir(), '.nexus');
  return path.join(nexusRoot, 'models', 'tesseract', DATASET_VERSION);
}

export async function ensureOcrLanguageData(
  targetDirectory = defaultOcrLanguageDirectory(),
): Promise<string> {
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await chmod(targetDirectory, 0o700);
  for (const artifact of OCR_LANGUAGE_ARTIFACTS) {
    await installArtifact(targetDirectory, artifact);
  }
  return targetDirectory;
}
