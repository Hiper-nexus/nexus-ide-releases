import path from 'node:path';

export const DEFAULT_DEV_USER_DATA_DIR = '.dev-user-data';

/**
 * Dev and the installed app must never share SQLite, settings, or the
 * single-instance lock. Keep an explicit override, but always make the path
 * absolute because Electron's app.setPath() expects one.
 */
export function createDevEnvironment(baseEnv, repoRoot) {
  const override = baseEnv.NEXUS_USER_DATA_DIR;
  const userDataDir =
    typeof override === 'string' && override.trim().length > 0
      ? path.resolve(repoRoot, override)
      : path.join(repoRoot, DEFAULT_DEV_USER_DATA_DIR);

  return {
    ...baseEnv,
    NEXUS_USER_DATA_DIR: userDataDir,
  };
}

function isFailedStart(result) {
  return Boolean(result?.signal) || (result?.code ?? 0) !== 0;
}

/**
 * better-sqlite3 has one build output shared by Node (tests/scripts) and
 * Electron (the app). Enter the Electron ABI before Forge, then always put the
 * Node ABI back so a dev session cannot poison the next Vitest/Node command.
 */
export async function runDevNativeLifecycle({
  rebuildElectron,
  startForge,
  rebuildNode,
  onRestoreError = () => {},
}) {
  let startResult;
  let primaryError;

  try {
    await rebuildElectron();
    startResult = await startForge();
  } catch (error) {
    primaryError = error;
  }

  let restoreError;
  try {
    await rebuildNode();
  } catch (error) {
    restoreError = error;
  }

  if (restoreError && (primaryError || isFailedStart(startResult))) {
    onRestoreError(restoreError);
  } else if (restoreError) {
    primaryError = restoreError;
  }

  if (primaryError) throw primaryError;
  return startResult;
}
