import os from 'node:os';
import path from 'node:path';

/**
 * Where the wake models live on disk. Kept apart from ensure-wake-models,
 * which carries the embedded models in base64: whoever only needs the paths
 * (the wake engine at construction) must not pull megabytes of models into
 * the app's boot.
 */

export const DEFAULT_WAKE_MODEL_FILE = 'speechkit-hey-jarvis.onnx';

/** PT-BR trained head installed as custom.onnx for every client by default. */
export const DEFAULT_PTBR_WAKE_MODEL_FILE = 'custom.onnx';

export function resolveWakeModelDirectory(): string {
  const configuredRoot = process.env.NEXUS_USER_DATA_DIR?.trim();
  const nexusRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(os.homedir(), '.nexus');
  return path.join(nexusRoot, 'models', 'wake');
}
