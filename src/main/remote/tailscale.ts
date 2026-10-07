// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Effect → async com
// execFile (timeout + SIGKILL + maxBuffer, LANG=C, binário absoluto, sem shell);
// Schema → zod; TaggedError → union {ok:false, reason}; Serve aponta para a
// bridge TLS (https+insecure://); `serve status --json` para nunca tocar em
// handler alheio; probe na rota pública /manifest.webmanifest com redirect:'error'.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
export const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
export const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;
export const TAILSCALE_PROBE_TIMEOUT_MS = 2_500;
export const TAILSCALE_MAX_BUFFER_BYTES = 1024 * 1024;
/** Rota pública e sem estado que a bridge já serve: o probe nunca toca token. */
export const TAILSCALE_PROBE_PATH = '/manifest.webmanifest';

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged/sent by IPC.
 */
export type TailscaleStderrDiagnostic =
  | 'no-existing-handler'
  | 'not-logged-in'
  | 'permission-denied'
  | 'serve-not-enabled'
  | 'unknown';

// Matched against stderr, most specific first. Patterns are deliberately short
// and anchored on tailscale's own wording.
const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, 'unknown'>]
> = [
  [/handler does not exist|no existing handler/i, 'no-existing-handler'],
  [/not logged in|logged out|needs? login/i, 'not-logged-in'],
  [/permission denied|access denied|must be root|operation not permitted/i, 'permission-denied'],
  [/serve is not enabled|https is not enabled|not enabled on your tailnet/i, 'serve-not-enabled'],
];

/** Classifies CLI output into a safe label, dropping the text itself. */
function stderrDiagnosticOf(stderr: string, stdout = ''): TailscaleStderrDiagnostic | undefined {
  const matched = (text: string) =>
    STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
  if (stderr.trim().length > 0) return matched(stderr) ?? matched(stdout) ?? 'unknown';
  // `tailscale serve` imprime alguns avisos (HTTPS desligado) no stdout.
  return matched(stdout);
}

export type TailscaleSubcommand = 'status' | 'serve';

interface TailscaleCommandContext {
  readonly subcommand: TailscaleSubcommand;
  readonly argumentCount: number;
}

/**
 * Falhas estruturadas: nunca carregam stderr/stdout/mensagem do processo —
 * só comprimentos e um rótulo da lista fechada acima.
 */
export type TailscaleCommandFailure =
  | (TailscaleCommandContext & { readonly ok: false; readonly reason: 'spawn' })
  | (TailscaleCommandContext & { readonly ok: false; readonly reason: 'output' })
  | (TailscaleCommandContext & {
      readonly ok: false;
      readonly reason: 'timeout';
      readonly timeoutMs: number;
      readonly stderrDiagnostic?: TailscaleStderrDiagnostic;
    })
  | (TailscaleCommandContext & {
      readonly ok: false;
      readonly reason: 'exit';
      readonly exitCode: number;
      readonly stdoutLength: number;
      readonly stderrLength: number;
      readonly stderrDiagnostic?: TailscaleStderrDiagnostic;
    });

export interface TailscaleParseFailure {
  readonly ok: false;
  readonly reason: 'parse';
}

export interface TailscaleExecOptions {
  readonly timeout: number;
  readonly killSignal: 'SIGKILL';
  readonly maxBuffer: number;
  readonly env: NodeJS.ProcessEnv;
  readonly encoding: 'utf8';
  readonly windowsHide: true;
  readonly shell: false;
}

/** Só os campos que a classificação lê; `message` (que cita stderr) é ignorada. */
export interface TailscaleExecError {
  readonly code?: unknown;
  readonly killed?: boolean;
  readonly signal?: unknown;
}

export type TailscaleExecFile = (
  file: string,
  args: readonly string[],
  options: TailscaleExecOptions,
  callback: (error: TailscaleExecError | null, stdout: string, stderr: string) => void,
) => unknown;

export interface TailscaleCli {
  /** Caminho absoluto resolvido entre candidatos fixos — nunca via PATH/shell. */
  readonly binary: string;
  readonly execFile: TailscaleExecFile;
}

const nodeExecFile: TailscaleExecFile = (file, args, options, callback) =>
  execFile(file, [...args], options, callback);

/**
 * Candidatos absolutos por plataforma. Um app aberto pelo Finder não herda
 * /usr/local/bin nem /opt/homebrew/bin no PATH, e resolver por PATH deixaria
 * qualquer diretório gravável do PATH escolher o binário.
 */
export function tailscaleBinaryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
    ];
  }
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles;
    const base =
      programFiles && path.win32.isAbsolute(programFiles)
        ? programFiles
        : 'C:\\Program Files';
    return [path.win32.join(base, 'Tailscale', 'tailscale.exe')];
  }
  return [
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/sbin/tailscale',
    '/snap/bin/tailscale',
  ];
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveTailscaleBinary(
  candidates: readonly string[] = tailscaleBinaryCandidates(),
  isExecutable: (candidate: string) => boolean = isExecutableFile,
): string | null {
  return candidates.find((candidate) => isExecutable(candidate)) ?? null;
}

/** CLI real do host, ou null quando o Tailscale não está instalado. */
export function resolveTailscaleCli(): TailscaleCli | null {
  const binary = resolveTailscaleBinary();
  return binary ? { binary, execFile: nodeExecFile } : null;
}

function tailscaleEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: 'C', LC_ALL: 'C' };
}

function classifyExecFailure(
  error: TailscaleExecError,
  stdout: string,
  stderr: string,
  context: TailscaleCommandContext,
  timeoutMs: number,
): TailscaleCommandFailure {
  const diagnostic = stderrDiagnosticOf(stderr, stdout);
  const withDiagnostic = diagnostic === undefined ? {} : { stderrDiagnostic: diagnostic };
  if (typeof error.code === 'number') {
    return {
      ok: false,
      reason: 'exit',
      ...context,
      exitCode: error.code,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      ...withDiagnostic,
    };
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { ok: false, reason: 'output', ...context };
  }
  if (error.killed === true || (typeof error.signal === 'string' && error.signal.length > 0)) {
    return { ok: false, reason: 'timeout', ...context, timeoutMs, ...withDiagnostic };
  }
  return { ok: false, reason: 'spawn', ...context };
}

function runTailscaleCommand(
  cli: TailscaleCli,
  args: readonly string[],
  subcommand: TailscaleSubcommand,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly stdout: string } | TailscaleCommandFailure> {
  const context: TailscaleCommandContext = { subcommand, argumentCount: args.length };
  return new Promise((resolve) => {
    try {
      cli.execFile(
        cli.binary,
        args,
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: TAILSCALE_MAX_BUFFER_BYTES,
          env: tailscaleEnv(),
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : '';
          const err = typeof stderr === 'string' ? stderr : '';
          if (!error) {
            resolve({ ok: true, stdout: out });
            return;
          }
          resolve(classifyExecFailure(error, out, err, context, timeoutMs));
        },
      );
    } catch {
      // Spawning can also throw synchronously — a non-directory entry on a
      // path makes node throw ENOTDIR. It must degrade like any spawn failure.
      resolve({ ok: false, reason: 'spawn', ...context });
    }
  });
}

const TailscaleStatusJson = z.object({
  BackendState: z.unknown().optional(),
  Self: z
    .object({
      DNSName: z.unknown().optional(),
      TailscaleIPs: z.unknown().optional(),
    })
    .optional(),
});

type TailscaleStatusJson = z.infer<typeof TailscaleStatusJson>;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
  /** `Running` quando logado e conectado; null em CLIs que não informam. */
  readonly backendState: string | null;
}

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== 'string') {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, '');
  return normalized.length > 0 ? normalized : null;
}

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function parseTailscaleStatus(
  rawStatusJson: string,
): { readonly ok: true; readonly status: TailscaleStatus } | TailscaleParseFailure {
  const parsed = TailscaleStatusJson.safeParse(parseJson(rawStatusJson));
  if (!parsed.success) return { ok: false, reason: 'parse' };
  const rawIps = parsed.data.Self?.TailscaleIPs;
  const tailnetIpv4Addresses: Array<string> = [];
  if (Array.isArray(rawIps)) {
    for (const address of rawIps) {
      if (typeof address === 'string' && isTailscaleIpv4Address(address)) {
        tailnetIpv4Addresses.push(address);
      }
    }
  }
  const backendState = parsed.data.BackendState;
  return {
    ok: true,
    status: {
      magicDnsName: normalizeMagicDnsName(parsed.data),
      tailnetIpv4Addresses,
      backendState: typeof backendState === 'string' ? backendState : null,
    },
  };
}

export async function readTailscaleStatus(
  cli: TailscaleCli,
): Promise<
  { readonly ok: true; readonly status: TailscaleStatus } | TailscaleCommandFailure | TailscaleParseFailure
> {
  const result = await runTailscaleCommand(
    cli,
    ['status', '--json'],
    'status',
    TAILSCALE_STATUS_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  return parseTailscaleStatus(result.stdout);
}

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = '/';
  return url.toString();
}

/**
 * A bridge do Nexus fala TLS com certificado self-signed; o Serve termina o
 * TLS válido *.ts.net e repassa ao loopback sem verificar o self-signed.
 */
export function buildTailscaleServeTarget(input: {
  readonly localPort: number;
  readonly localHost?: string;
}): string {
  return `https+insecure://${input.localHost ?? '127.0.0.1'}:${input.localPort}`;
}

const ServeConfigBase = z.object({
  TCP: z.record(z.string(), z.object({ TCPForward: z.unknown().optional() })).optional(),
  Web: z
    .record(
      z.string(),
      z.object({
        Handlers: z
          .record(z.string(), z.object({ Proxy: z.unknown().optional() }))
          .optional(),
      }),
    )
    .optional(),
});
const ServeConfigJson = ServeConfigBase.extend({
  Foreground: z.record(z.string(), ServeConfigBase).optional(),
});
export type TailscaleServeConfig = z.infer<typeof ServeConfigJson>;

export function parseTailscaleServeConfig(
  raw: string,
): { readonly ok: true; readonly config: TailscaleServeConfig } | TailscaleParseFailure {
  // Sem nenhuma configuração a CLI imprime `{}` (ou nada, em versões antigas).
  const parsed = ServeConfigJson.safeParse(raw.trim().length === 0 ? {} : parseJson(raw));
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, reason: 'parse' };
}

export async function readTailscaleServeConfig(
  cli: TailscaleCli,
): Promise<
  | { readonly ok: true; readonly config: TailscaleServeConfig }
  | TailscaleCommandFailure
  | TailscaleParseFailure
> {
  const result = await runTailscaleCommand(
    cli,
    ['serve', 'status', '--json'],
    'serve',
    TAILSCALE_STATUS_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  return parseTailscaleServeConfig(result.stdout);
}

/**
 * Quem ocupa a porta do Serve: `ours` só quando TODO handler nela é o proxy
 * exato que o Nexus registrou na raiz. Qualquer outra coisa é `foreign` e
 * nunca é sobrescrita nem desligada.
 */
export function classifyTailscaleServePort(
  config: TailscaleServeConfig,
  servePort: number,
  ownedTarget: string | null,
): 'free' | 'ours' | 'foreign' {
  const configs = [config, ...Object.values(config.Foreground ?? {})];
  let occupied = false;
  let sawOurs = false;
  for (const entry of configs) {
    const tcp = entry.TCP?.[String(servePort)];
    if (tcp) {
      occupied = true;
      if (tcp.TCPForward !== undefined && tcp.TCPForward !== '') return 'foreign';
    }
    for (const [hostPort, web] of Object.entries(entry.Web ?? {})) {
      if (!hostPort.endsWith(`:${servePort}`)) continue;
      occupied = true;
      for (const [mount, handler] of Object.entries(web.Handlers ?? {})) {
        if (ownedTarget !== null && mount === '/' && handler.Proxy === ownedTarget) {
          sawOurs = true;
        } else {
          return 'foreign';
        }
      }
    }
  }
  if (!occupied) return 'free';
  return sawOurs ? 'ours' : 'foreign';
}

export async function ensureTailscaleServe(
  cli: TailscaleCli,
  input: {
    readonly localPort: number;
    readonly servePort?: number;
    readonly localHost?: string;
  },
): Promise<{ readonly ok: true } | TailscaleCommandFailure> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const args = [
    'serve',
    '--bg',
    `--https=${servePort}`,
    buildTailscaleServeTarget(input),
  ];
  const result = await runTailscaleCommand(cli, args, 'serve', TAILSCALE_SERVE_TIMEOUT_MS);
  return result.ok ? { ok: true } : result;
}

export async function disableTailscaleServe(
  cli: TailscaleCli,
  input: { readonly servePort?: number } = {},
): Promise<{ readonly ok: true } | TailscaleCommandFailure> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const result = await runTailscaleCommand(
    cli,
    ['serve', `--https=${servePort}`, 'off'],
    'serve',
    TAILSCALE_SERVE_TIMEOUT_MS,
  );
  if (result.ok) return { ok: true };
  // Desligar o que já não existe é sucesso (idempotente).
  if (result.reason === 'exit' && result.stderrDiagnostic === 'no-existing-handler') {
    return { ok: true };
  }
  return result;
}

export async function probeTailscaleHttpsEndpoint(input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const url = new URL(TAILSCALE_PROBE_PATH, input.baseUrl);
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      // Um redirect sairia do host *.ts.net provado; tratamos como falha.
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? TAILSCALE_PROBE_TIMEOUT_MS),
    });
    try {
      await response.body?.cancel();
    } catch {
      // Corpo já consumido/fechado.
    }
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}
