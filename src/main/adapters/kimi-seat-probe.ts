import { execFile } from 'node:child_process';
import { resolveCliBinary } from '../path-resolver';
import { windowsCliProbeLaunch } from './windows-npm-shim';
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

/**
 * Caminho absoluto quando existir. O app empacotado nasce com o PATH mínimo do
 * Finder até o fold do login-shell assentar; um nome nu em ENOENT vira
 * `missing` — veredito FALSO de "sem credencial" que remapeia o assento.
 */
function resolveKimiBin(): string {
  try {
    return resolveCliBinary('kimi')?.binPath ?? 'kimi';
  } catch {
    return 'kimi';
  }
}

function defaultExecProviderList(): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveKimiBin();
  const args = ['provider', 'list', '--json'];
  // F-1507: sem `shell: true` (caminho com espaço quebrava no cmd.exe).
  const launch: ReturnType<typeof windowsCliProbeLaunch> = process.platform === 'win32'
    ? windowsCliProbeLaunch('kimi', bin, args)
    : { file: bin, args };
  return new Promise((resolve, reject) => {
    execFile(
      launch.file,
      launch.args,
      {
        timeout: EXEC_TIMEOUT_MS,
        encoding: 'utf8',
        ...(process.platform === 'win32'
          ? { windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments === true }
          : {}),
      },
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
 * A4 (perf spawn): a rota de missão chamava `kimi provider list --json`
 * (timeout 4s) em TODO spawn. TTL 60s + single-flight no padrão do memo AGY
 * (subscription-auth.ts). Sem gancho de login externo: `invalidateKimiSeatProbeCache`
 * fica disponível quando o estado de login mudar.
 */
const KIMI_SEAT_MEMO_TTL_MS = 60_000;
let kimiSeatMemo: { at: number; value: SeatAuthReadiness } | undefined;
let kimiSeatInFlight: Promise<SeatAuthReadiness> | undefined;

/** Invalida o memo quando o estado de login do Kimi mudar. */
export function invalidateKimiSeatProbeCache(): void {
  kimiSeatMemo = undefined;
  kimiSeatInFlight = undefined;
}

/** Test hook. */
export function resetKimiSeatProbeMemoForTests(): void {
  invalidateKimiSeatProbeCache();
}

/**
 * Refresh Kimi seating proof from `kimi provider list --json`.
 * Stale "No providers configured" must not override a live oauth source.
 */
export async function refreshKimiSeatReadiness(
  deps: KimiSeatProbeDeps = { execProviderList: defaultExecProviderList },
): Promise<SeatAuthReadiness> {
  if (kimiSeatMemo && Date.now() - kimiSeatMemo.at < KIMI_SEAT_MEMO_TTL_MS) {
    return kimiSeatMemo.value;
  }
  if (kimiSeatInFlight) return kimiSeatInFlight;
  const run = async (): Promise<SeatAuthReadiness> => {
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
  };
  kimiSeatInFlight = run()
    .then((value) => {
      kimiSeatMemo = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      kimiSeatInFlight = undefined;
    });
  return kimiSeatInFlight;
}
