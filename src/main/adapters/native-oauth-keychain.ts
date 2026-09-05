import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { slimClaudeCredentialBlob } from './claude-credential';

/** OpenClaude uses its own service, with a hash for a non-default config home. */
export function openClaudeKeychainService(home: string, configDir?: string): string {
  const defaultDir = path.resolve(home, '.openclaude').normalize('NFC');
  const resolved = path.resolve(configDir || defaultDir).normalize('NFC');
  const suffix = resolved === defaultDir ? '' :
    `-${createHash('sha256').update(resolved).digest('hex').slice(0, 8)}`;
  return `OpenClaude-credentials${suffix}`;
}

/** Main-only bounded read; returns the slim OAuth slice and never logs it. */
export function readNativeOAuthCredential(
  service: string,
  execImpl: typeof execFile = execFile,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execImpl('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 5_000,
      killSignal: 'SIGKILL',
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (!error) return resolve(slimClaudeCredentialBlob(stdout));
      if (error.code === 44) return resolve(null);
      reject(new Error('Keychain unavailable'));
    });
  });
}

export async function readNativeOAuthKeychain(
  service: string,
  execImpl: typeof execFile = execFile,
): Promise<boolean> {
  return (await readNativeOAuthCredential(service, execImpl)) !== null;
}
