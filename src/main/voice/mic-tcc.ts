/**
 * Recuperação do grant TCC fantasma (WAKE-BROKEN-001 Rank 1): macOS diz
 * 'granted' mas entrega PCM zerado. Fix documentado: tccutil reset Microphone
 * <bundleId> + relançar + clicar Permitir. Helpers puros/finos, testáveis.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Extrai o caminho do bundle .app do execPath (null fora de um .app). */
export function appBundlePathFromExecPath(execPath: string): string | null {
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1] : null;
}

/** Lê o CFBundleIdentifier do Info.plist do bundle (macOS). */
export async function readBundleId(appBundlePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('defaults', [
      'read',
      `${appBundlePath}/Contents/Info`,
      'CFBundleIdentifier',
    ]);
    const id = stdout.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Reseta a entrada TCC de microfone do próprio bundle. Lança em falha. */
export async function resetMicrophoneTcc(bundleId: string): Promise<void> {
  await execFileP('tccutil', ['reset', 'Microphone', bundleId]);
}
