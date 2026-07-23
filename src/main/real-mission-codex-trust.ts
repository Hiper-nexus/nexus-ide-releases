import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'smol-toml';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function stageRealMissionCodexTrust(
  userData: string,
  workspacePath: string,
): string {
  const canonicalUserData = fs.realpathSync(userData);
  const canonicalWorkspace = fs.realpathSync(workspacePath);
  if (!isStrictDescendant(canonicalUserData, canonicalWorkspace)) {
    throw new Error('Codex workspace is outside disposable user data');
  }

  const homePath = path.join(canonicalUserData, 'home');
  const codexDirectory = path.join(homePath, '.codex');
  fs.mkdirSync(codexDirectory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  fs.chmodSync(homePath, PRIVATE_DIRECTORY_MODE);
  fs.chmodSync(codexDirectory, PRIVATE_DIRECTORY_MODE);

  const configPath = path.join(codexDirectory, 'config.toml');
  let fileDescriptor: number | undefined;
  let didCreate = false;
  let didComplete = false;
  try {
    fileDescriptor = fs.openSync(configPath, 'wx', PRIVATE_FILE_MODE);
    didCreate = true;
    const config = stringify({
      projects: {
        [canonicalWorkspace]: {
          trust_level: 'trusted',
        },
      },
    });
    fs.writeFileSync(fileDescriptor, `${config.trimEnd()}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.chmodSync(configPath, PRIVATE_FILE_MODE);
    didComplete = true;
    return configPath;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new Error('Codex config already exists');
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    if (didCreate && !didComplete) {
      fs.rmSync(configPath, { force: true });
    }
  }
}
