import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HEIC_CONVERT_MAX_SOURCE_BYTES,
  type HeicConvertFailureReason,
  type HeicConvertResult,
} from '../../shared/files-types';
import {
  heicDimensionsError,
  MAX_HEIC_METADATA_BYTES,
} from '../../shared/heic-metadata';

/**
 * HEIC/HEIF → JPEG para anexos. O renderer não tem decoder (o do T3, heic-to,
 * é LGPL) e o `nativeImage` do Electron 43 devolve imagem vazia para HEIC no
 * macOS (sonda real com arquivo gerado por `sips`). Por isso o Main usa o
 * decoder do sistema: `/usr/bin/sips` (ImageIO) num processo filho com prazo,
 * em pasta temporária privada, com teto de bytes na entrada e na saída.
 * Fora do macOS não há decoder do sistema: a resposta é `unsupported`, legível.
 */

export const HEIC_UNSUPPORTED_MESSAGE = 'HEIC não suportado neste sistema.';
export const HEIC_CONVERT_TIMEOUT_MS = 20_000;
/** JPEG q92 de 64 MP fica bem abaixo disto; acima, algo está errado. */
export const HEIC_CONVERT_MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const HEIC_CONVERT_MAX_IN_FLIGHT = 2;
const SIPS_PATH = '/usr/bin/sips';
/** Mesmo primeiro degrau de qualidade do T3 (QUALITY_STEPS[0]). */
const JPEG_QUALITY = '92';

export type HeicExecFile = (
  file: string,
  args: readonly string[],
  options: {
    timeout: number;
    killSignal: NodeJS.Signals;
    maxBuffer: number;
    windowsHide: boolean;
    env: NodeJS.ProcessEnv;
  },
  callback: (
    error: (Error & { killed?: boolean; signal?: NodeJS.Signals | null }) | null,
  ) => void,
) => unknown;

export interface HeicConvertDeps {
  platform?: NodeJS.Platform;
  sipsPath?: string;
  timeoutMs?: number;
  tmpDir?: string;
  execFile?: HeicExecFile;
}

const defaultExecFile: HeicExecFile = (file, args, options, callback) =>
  execFile(file, [...args], options, (error) => callback(error));

let inFlight = 0;

function failure(
  reason: HeicConvertFailureReason,
  error: string,
): HeicConvertResult {
  return { ok: false, reason, error };
}

/** IPC payload `{ bytes }`: Uint8Array (structured clone) ou ArrayBuffer. */
export function heicConvertPayloadBytes(raw: unknown): Uint8Array | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as { bytes?: unknown }).bytes;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs >= 1000
    ? `${Math.round(timeoutMs / 1000)} s`
    : `${timeoutMs} ms`;
}

function runSips(
  run: HeicExecFile,
  sipsPath: string,
  input: string,
  output: string,
  timeoutMs: number,
): Promise<HeicConvertResult | null> {
  return new Promise((resolve) => {
    try {
      run(
        sipsPath,
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY, input, '--out', output],
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024,
          windowsHide: true,
          env: { PATH: '/usr/bin:/bin' },
        },
        (error) => {
          if (!error) {
            resolve(null);
            return;
          }
          resolve(
            error.killed || error.signal === 'SIGKILL'
              ? failure(
                  'unreadable',
                  `A conversão HEIC passou do prazo de ${formatTimeout(timeoutMs)}.`,
                )
              : failure('unreadable', 'Não foi possível converter a foto HEIC para JPEG.'),
          );
        },
      );
    } catch {
      resolve(failure('unreadable', 'Não foi possível converter a foto HEIC para JPEG.'));
    }
  });
}

export async function convertHeicToJpeg(
  bytes: Uint8Array,
  deps: HeicConvertDeps = {},
): Promise<HeicConvertResult> {
  if (bytes.byteLength === 0) {
    return failure('unreadable', 'A foto HEIC está vazia.');
  }
  if (bytes.byteLength > HEIC_CONVERT_MAX_SOURCE_BYTES) {
    return failure('too-large', 'A foto HEIC passa de 50 MB e não será convertida.');
  }
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return failure('unsupported', HEIC_UNSUPPORTED_MESSAGE);
  }
  const sipsPath = deps.sipsPath ?? SIPS_PATH;
  try {
    await fs.access(sipsPath, fsConstants.X_OK);
  } catch {
    return failure('unsupported', HEIC_UNSUPPORTED_MESSAGE);
  }
  // Mesmo preflight do renderer: o Main não confia no outro lado da ponte.
  const dimensions = heicDimensionsError(
    new DataView(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(bytes.byteLength, MAX_HEIC_METADATA_BYTES),
    ),
  );
  if (dimensions === 'too-large') {
    return failure('too-large', 'A foto HEIC tem mais de 64 megapixels.');
  }
  if (dimensions) {
    return failure('unreadable', 'O arquivo não é uma foto HEIC/HEIF válida.');
  }
  if (inFlight >= HEIC_CONVERT_MAX_IN_FLIGHT) {
    return failure('unreadable', 'Outra conversão HEIC está em andamento; tente de novo.');
  }

  inFlight += 1;
  let workDir: string | null = null;
  try {
    // mkdtemp cria a pasta com modo 0700: só este usuário enxerga a foto.
    workDir = await fs.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), 'nexus-heic-'));
    const input = path.join(workDir, 'input.heic');
    const output = path.join(workDir, 'output.jpg');
    await fs.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
    const failed = await runSips(
      deps.execFile ?? defaultExecFile,
      sipsPath,
      input,
      output,
      deps.timeoutMs ?? HEIC_CONVERT_TIMEOUT_MS,
    );
    if (failed) return failed;
    const stat = await fs.lstat(output);
    if (!stat.isFile()) {
      return failure('unreadable', 'Não foi possível converter a foto HEIC para JPEG.');
    }
    if (stat.size > HEIC_CONVERT_MAX_OUTPUT_BYTES) {
      return failure('too-large', 'O JPEG convertido ficou grande demais.');
    }
    const jpeg = await fs.readFile(output);
    if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
      return failure('unreadable', 'Não foi possível converter a foto HEIC para JPEG.');
    }
    return { ok: true, bytes: jpeg };
  } catch {
    return failure('unreadable', 'Não foi possível converter a foto HEIC para JPEG.');
  } finally {
    inFlight -= 1;
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
