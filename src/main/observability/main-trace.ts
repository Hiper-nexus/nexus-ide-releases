/**
 * main.trace.ndjson — o log persistido do processo main (campanha 0.50, A7;
 * doutrina Orca `observability/local-file-sink`): o app empacotado descarta
 * o stdout, então TODO pós-mortem noturno era cego. Este sink grava eventos
 * estruturados em `userData/logs/main.trace.ndjson`, best-effort e
 * NUNCA lançando — instrumentação não pode derrubar o que instrumenta.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Teto do arquivo corrente antes de girar (5 MB). */
export const TRACE_ROTATION_BYTES = 5 * 1024 * 1024;
/** Gerações rotacionadas mantidas (main.trace.ndjson.1 … .3). */
export const TRACE_ROTATION_GENERATIONS = 3;

const SENSITIVE_KEY_RE = /key|token|secret|password|authorization|bearer|credential/i;

/** Redige recursivamente valores de chaves sensíveis (nunca lança). */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : redactSecrets(v, depth + 1);
  }
  return out;
}

/** Linha NDJSON determinística (testável sem I/O). */
export function formatTraceLine(
  event: Record<string, unknown>,
  at: number,
): string {
  return `${JSON.stringify({ ...event, at })}\n`;
}

/** Decide rotação por tamanho (testável sem I/O). */
export function shouldRotate(sizeBytes: number): boolean {
  return sizeBytes >= TRACE_ROTATION_BYTES;
}

let traceDir: string | null = null;
let tracePath: string | null = null;
let lastErrorLoggedAt = 0;
let directoryOverride: string | null = null;

/**
 * Diretório explícito (testes/boot). Sem override, resolve pelo
 * app.getPath('userData') do Electron — no main process ele sempre existe;
 * fora dele (testes puros) o trace no-op silenciosamente.
 */
export function setTraceDirectory(dir: string | null): void {
  directoryOverride = dir;
  traceDir = null;
  tracePath = null;
}

function resolveUserDataDir(): string | null {
  if (directoryOverride) return directoryOverride;
  try {
    // Dynamic require: mantém o módulo importável em contexto sem Electron.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    return electron.app?.getPath?.('userData') ?? null;
  } catch {
    return null;
  }
}

function ensurePaths(): { dir: string; file: string } | null {
  if (traceDir && tracePath) return { dir: traceDir, file: tracePath };
  try {
    const root = resolveUserDataDir();
    if (!root) return null;
    const dir = join(root, 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    traceDir = dir;
    tracePath = join(dir, 'main.trace.ndjson');
    return { dir, file: tracePath };
  } catch {
    return null;
  }
}

function rotate(file: string): void {
  try {
    for (let i = TRACE_ROTATION_GENERATIONS - 1; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
  } catch {
    // Rotação falhou: segue gravando no corrente — melhor que perder o trace.
  }
}

/**
 * Grava um evento no trace. Fire-and-forget, síncrono de propósito (linhas
 * pequenas, append atômico em APEND — o custo é desprezível e a durabilidade
 * do caminho de quit não depende de flush pendente). Falhas viram warn
 * THROTTLED: um disco cheio não pode virar spam de log a cada evento.
 */
export function trace(event: Record<string, unknown>): void {
  try {
    const paths = ensurePaths();
    if (!paths) return;
    try {
      if (shouldRotate(statSync(paths.file).size)) rotate(paths.file);
    } catch {
      // Arquivo ainda não existe: sem rotação.
    }
    appendFileSync(
      paths.file,
      formatTraceLine(redactSecrets(event) as Record<string, unknown>, Date.now()),
      'utf8',
    );
  } catch (error) {
    const now = Date.now();
    if (now - lastErrorLoggedAt > 60_000) {
      lastErrorLoggedAt = now;
      console.warn('[main-trace] gravação falhou (throttled):', error);
    }
  }
}
