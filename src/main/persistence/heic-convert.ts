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
  MAX_HEIC_DECODE_PIXELS,
  MAX_HEIC_METADATA_BYTES,
} from '../../shared/heic-metadata';

/**
 * HEIC/HEIF → JPEG para anexos. O renderer não tem decoder (o do T3, heic-to,
 * é LGPL) e o `nativeImage` do Electron 43 devolve imagem vazia para HEIC no
 * macOS (sonda real com arquivo gerado por `sips`). Por isso o Main usa o
 * decoder do sistema: `/usr/bin/sips` (ImageIO) num processo filho com prazo,
 * em pasta temporária privada, com teto de bytes na entrada e na saída.
 * Fora do macOS não há decoder do sistema: a resposta é `unsupported`, legível.
 *
 * O teto de pixels vale em três pontos, porque o `ispe` lido pelo parser é
 * só o que o arquivo DECLARA: (1) parser de metadados, antes de qualquer
 * processo; (2) `sips -g pixelWidth -g pixelHeight`, que pergunta ao próprio
 * ImageIO o tamanho que ele vai decodificar, antes de converter; (3) o SOF do
 * JPEG de saída, depois de converter e antes de devolver os bytes. O `sips`
 * não tem teto próprio (converte 8200×8000 sem reclamar — sonda real).
 */

export const HEIC_UNSUPPORTED_MESSAGE = 'HEIC não suportado neste sistema.';
export const HEIC_CONVERT_TIMEOUT_MS = 20_000;
/** Ler propriedades não decodifica a imagem: prazo curto. */
const HEIC_PROBE_TIMEOUT_MS = 5_000;
/** JPEG q92 de 64 MP fica bem abaixo disto; acima, algo está errado. */
export const HEIC_CONVERT_MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const HEIC_CONVERT_MAX_IN_FLIGHT = 2;
const SIPS_PATH = '/usr/bin/sips';
/** Mesmo primeiro degrau de qualidade do T3 (QUALITY_STEPS[0]). */
const JPEG_QUALITY = '92';
const CONVERT_FAILED = 'Não foi possível converter a foto HEIC para JPEG.';
const NOT_HEIC = 'O arquivo não é uma foto HEIC/HEIF válida.';

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
    stdout?: string,
  ) => void,
) => unknown;

export interface HeicConvertDeps {
  platform?: NodeJS.Platform;
  sipsPath?: string;
  timeoutMs?: number;
  tmpDir?: string;
  execFile?: HeicExecFile;
  /** Só testes: teto da sonda e da saída (o parser usa sempre o real). */
  maxPixels?: number;
  /** Só testes: teto de bytes do JPEG de saída. */
  maxOutputBytes?: number;
}

const defaultExecFile: HeicExecFile = (file, args, options, callback) =>
  execFile(file, [...args], options, (error, stdout) => callback(error, String(stdout)));

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

function formatMegapixels(pixels: number): string {
  return (pixels / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function exceeds(width: number, height: number, maxPixels: number): boolean {
  return width > maxPixels / height;
}

type SipsRun = { ok: true; stdout: string } | { ok: false; result: HeicConvertResult };

function runSips(
  run: HeicExecFile,
  sipsPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<SipsRun> {
  const failed = (error: { killed?: boolean; signal?: NodeJS.Signals | null }): SipsRun => ({
    ok: false,
    result:
      error.killed || error.signal === 'SIGKILL'
        ? failure('unreadable', `A conversão HEIC passou do prazo de ${formatTimeout(timeoutMs)}.`)
        : failure('unreadable', CONVERT_FAILED),
  });
  return new Promise((resolve) => {
    try {
      run(
        sipsPath,
        args,
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024,
          windowsHide: true,
          env: { PATH: '/usr/bin:/bin' },
        },
        (error, stdout) => resolve(error ? failed(error) : { ok: true, stdout: stdout ?? '' }),
      );
    } catch {
      resolve({ ok: false, result: failure('unreadable', CONVERT_FAILED) });
    }
  });
}

/** `sips -g pixelWidth -g pixelHeight`: `<nil>` (ImageIO recusou) vira null. */
export function parseSipsDimensions(stdout: string): { width: number; height: number } | null {
  const width = /^\s*pixelWidth:\s*(\d+)\s*$/m.exec(stdout)?.[1];
  const height = /^\s*pixelHeight:\s*(\d+)\s*$/m.exec(stdout)?.[1];
  if (!width || !height) return null;
  const parsed = { width: Number(width), height: Number(height) };
  return Number.isSafeInteger(parsed.width) &&
    Number.isSafeInteger(parsed.height) &&
    parsed.width > 0 &&
    parsed.height > 0
    ? parsed
    : null;
}

/** Dimensões do primeiro SOF de um JPEG; null se não houver SOF legível. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7) return null;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
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
    return failure(
      'too-large',
      `A foto HEIC tem mais de ${formatMegapixels(MAX_HEIC_DECODE_PIXELS)} megapixels.`,
    );
  }
  if (dimensions) {
    return failure('unreadable', NOT_HEIC);
  }
  if (inFlight >= HEIC_CONVERT_MAX_IN_FLIGHT) {
    return failure('unreadable', 'Outra conversão HEIC está em andamento; tente de novo.');
  }

  const maxPixels = deps.maxPixels ?? MAX_HEIC_DECODE_PIXELS;
  const timeoutMs = deps.timeoutMs ?? HEIC_CONVERT_TIMEOUT_MS;
  const run = deps.execFile ?? defaultExecFile;
  inFlight += 1;
  let workDir: string | null = null;
  try {
    // mkdtemp cria a pasta com modo 0700: só este usuário enxerga a foto.
    workDir = await fs.mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), 'nexus-heic-'));
    const input = path.join(workDir, 'input.heic');
    const output = path.join(workDir, 'output.jpg');
    await fs.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });

    // O tamanho que o ImageIO vai decodificar, não o que o ispe declara.
    const probe = await runSips(
      run,
      sipsPath,
      ['-g', 'pixelWidth', '-g', 'pixelHeight', input],
      Math.min(HEIC_PROBE_TIMEOUT_MS, timeoutMs),
    );
    if (!probe.ok) return probe.result;
    const decoded = parseSipsDimensions(probe.stdout);
    if (!decoded) return failure('unreadable', NOT_HEIC);
    if (exceeds(decoded.width, decoded.height, maxPixels)) {
      return failure('too-large', `A foto HEIC tem mais de ${formatMegapixels(maxPixels)} megapixels.`);
    }

    const converted = await runSips(
      run,
      sipsPath,
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY, input, '--out', output],
      timeoutMs,
    );
    if (!converted.ok) return converted.result;
    const stat = await fs.lstat(output);
    if (!stat.isFile()) {
      return failure('unreadable', CONVERT_FAILED);
    }
    if (stat.size > (deps.maxOutputBytes ?? HEIC_CONVERT_MAX_OUTPUT_BYTES)) {
      return failure('too-large', 'O JPEG convertido ficou grande demais.');
    }
    const jpeg = await fs.readFile(output);
    const size = jpegDimensions(jpeg);
    if (!size) {
      return failure('unreadable', CONVERT_FAILED);
    }
    if (exceeds(size.width, size.height, maxPixels)) {
      return failure('too-large', `O JPEG convertido passou de ${formatMegapixels(maxPixels)} megapixels.`);
    }
    return { ok: true, bytes: jpeg };
  } catch {
    return failure('unreadable', CONVERT_FAILED);
  } finally {
    inFlight -= 1;
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
