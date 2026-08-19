import { execFile } from 'node:child_process';
import {
  classifyKimiProviderList,
  mergeKimiProviderListReadiness,
  peekKimiSeatReadiness,
  rememberKimiSeatReadiness,
  type SeatAuthReadiness,
} from './seat-auth-readiness';

const EXEC_TIMEOUT_MS = 4_000;

export interface KimiSeatProbeDeps {
  execProviderList(): Promise<{ stdout: string; stderr: string }>;
}

function defaultExecProviderList(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'kimi',
      ['provider', 'list', '--json'],
      { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(err);
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

function classifyExecError(err: unknown): SeatAuthReadiness {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === 'ENOENT') return 'missing';
  return 'unreadable';
}

/**
 * Refresh Kimi seating proof from `kimi provider list --json`.
 * Stale "No providers configured" must not override a live oauth source.
 */
export async function refreshKimiSeatReadiness(
  deps: KimiSeatProbeDeps = { execProviderList: defaultExecProviderList },
): Promise<SeatAuthReadiness> {
  const stale = peekKimiSeatReadiness();
  let live: SeatAuthReadiness;
  try {
    const { stdout, stderr } = await deps.execProviderList();
    live = classifyKimiProviderList(`${stdout}\n${stderr}`);
  } catch (err) {
    live = classifyExecError(err);
  }
  const merged = mergeKimiProviderListReadiness(live, stale);
  rememberKimiSeatReadiness(merged);
  return merged;
}
