import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEY_JARVIS_ONNX_B64 } from './wake-models';
import {
  EI_JARVIS_PTBR_ONNX_B64,
  EI_JARVIS_PTBR_ONNX_SHA256,
} from './wake-models-ptbr';

/** SpeechKit `hey_jarvis` head, installed as an optional second detector. */
export const DEFAULT_WAKE_MODEL_SHA256 =
  '7256019a18029c7bea33abc3344f7a3d0e07655cf4a5f18e65c9b6329eac3fb6';
export const DEFAULT_WAKE_MODEL_FILE = 'speechkit-hey-jarvis.onnx';

/** PT-BR trained head installed as custom.onnx for every client by default. */
export const DEFAULT_PTBR_WAKE_MODEL_FILE = 'custom.onnx';
export const DEFAULT_PTBR_WAKE_MODEL_SHA256 = EI_JARVIS_PTBR_ONNX_SHA256;

function defaultWakeDirectory(): string {
  const configuredRoot = process.env.NEXUS_USER_DATA_DIR?.trim();
  const nexusRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(os.homedir(), '.nexus');
  return path.join(nexusRoot, 'models', 'wake');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasExpectedHash(filePath: string, expected: string): boolean {
  try {
    return sha256(fs.readFileSync(filePath)) === expected;
  } catch {
    return false;
  }
}

function installModelFile(
  targetDirectory: string,
  fileName: string,
  bytes: Buffer,
  expectedSha: string,
  label: string,
): string | null {
  const target = path.join(targetDirectory, fileName);
  if (hasExpectedHash(target, expectedSha)) return target;
  if (sha256(bytes) !== expectedSha) {
    console.warn(`[wake] ${label} checksum mismatch — skip disk install`);
    return null;
  }

  try {
    fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      targetDirectory,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(temporary, target);
      } catch {
        fs.rmSync(target, { force: true });
        fs.renameSync(temporary, target);
      }
      fs.chmodSync(target, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    if (!hasExpectedHash(target, expectedSha)) {
      console.warn(`[wake] ${label} failed verification after write`);
      return null;
    }
    console.log(`[wake] ${label} instalado: ${target}`);
    return target;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[wake] falha ao instalar ${label} (${message})`);
    return null;
  }
}

export function ensureDefaultWakeModelInstalled(
  targetDirectory = defaultWakeDirectory(),
): string | null {
  return installModelFile(
    targetDirectory,
    DEFAULT_WAKE_MODEL_FILE,
    Buffer.from(HEY_JARVIS_ONNX_B64, 'base64'),
    DEFAULT_WAKE_MODEL_SHA256,
    'modelo treinado EN (SpeechKit)',
  );
}

export function ensureDefaultPtbrWakeModelInstalled(
  targetDirectory = defaultWakeDirectory(),
): string | null {
  const target = path.join(targetDirectory, DEFAULT_PTBR_WAKE_MODEL_FILE);
  // A local retraining is an explicit user override and must survive upgrades.
  if (
    fs.existsSync(target) &&
    !hasExpectedHash(target, DEFAULT_PTBR_WAKE_MODEL_SHA256)
  ) {
    console.log(`[wake] custom.onnx do usuário preservado: ${target}`);
    return target;
  }
  return installModelFile(
    targetDirectory,
    DEFAULT_PTBR_WAKE_MODEL_FILE,
    Buffer.from(EI_JARVIS_PTBR_ONNX_B64, 'base64'),
    DEFAULT_PTBR_WAKE_MODEL_SHA256,
    'modelo treinado PT-BR (Ei Jarvis)',
  );
}

export function ensureAllDefaultWakeModelsInstalled(
  targetDirectory = defaultWakeDirectory(),
): { readonly en: string | null; readonly ptbr: string | null } {
  return Object.freeze({
    en: ensureDefaultWakeModelInstalled(targetDirectory),
    ptbr: ensureDefaultPtbrWakeModelInstalled(targetDirectory),
  });
}
