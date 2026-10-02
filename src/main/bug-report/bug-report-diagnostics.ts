import fs from 'node:fs/promises';
import os from 'node:os';
import {
  BUG_REPORT_LIMITS,
  BUG_REPORT_PLATFORMS,
  type BugReportDiagnosticEvent,
  type BugReportPayload,
  type BugReportPlatform,
} from '../../shared/bug-report';
import { getTraceFilePath } from '../observability/main-trace';

/**
 * Diagnóstico do reporte de problema, montado SÓ no Main.
 *
 * Princípio: lista de permissão, nunca de bloqueio. O trace do app
 * (`main.trace.ndjson`) carrega argumentos, caminhos, ids e até trechos de
 * conversa em alguns eventos; daqui sai apenas o TIPO do evento (`kind`), um
 * código curto e o instante. Qualquer outro campo é descartado antes de
 * existir como valor — não há o que redigir porque nunca foi copiado.
 */

export interface DiagnosticsAgentSession {
  paneId?: string;
  adapterId: string;
  model?: string;
  missionId?: string;
}

export interface DiagnosticsDeps {
  appVersion: string;
  /** `process.platform` — valores fora do contrato caem em `linux`. */
  platform: string;
  arch: string;
  osVersion: string;
  /** Inventário físico de sessões de agente (somente leitura). */
  listAgentSessions: () => readonly DiagnosticsAgentSession[];
  /** Cauda do trace como texto NDJSON; `null` quando não há trace. */
  readTraceTail: () => Promise<string | null>;
}

type AppInfo = BugReportPayload['app'];
type Context = NonNullable<BugReportPayload['context']>;
type Diagnostics = NonNullable<BugReportPayload['diagnostics']>;

/** Quanto do fim do trace é lido (o arquivo gira em 5 MB). */
const TRACE_TAIL_BYTES = 256 * 1024;
/** Eventos recentes considerados ao derivar a lista de erros. */
const ERROR_WINDOW = 200;

const KIND_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;
const CODE_TOKEN = /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,78}$/;
const ADAPTER_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/;
const FAILURE_WORDS = /error|fail|crash|gone|denied|timeout|dropped|killed|hang|refused|invalid|abort|died|dead/i;

function isContractPlatform(value: string): value is BugReportPlatform {
  return (BUG_REPORT_PLATFORMS as readonly string[]).includes(value);
}

export function buildAppInfo(deps: DiagnosticsDeps): AppInfo {
  const osVersion = deps.osVersion.trim().slice(0, 64);
  return {
    version: deps.appVersion,
    platform: isContractPlatform(deps.platform) ? deps.platform : 'linux',
    arch: deps.arch,
    ...(osVersion ? { osVersion } : {}),
  };
}

/**
 * Agente em foco e tamanho da frota. Só `adapterId`/`model` (tokens curtos),
 * a contagem de panes e se há missão — nunca ids de pane, de missão, de conta
 * nem o diretório de trabalho.
 */
export function buildContext(deps: DiagnosticsDeps, activePaneId?: string): Context {
  const sessions = deps.listAgentSessions();
  const active =
    activePaneId === undefined
      ? sessions.at(-1)
      : sessions.find((session) => session.paneId === activePaneId);
  const paneKeys = new Set(sessions.map((session, index) => session.paneId ?? `#${index}`));
  const adapter = active && ADAPTER_TOKEN.test(active.adapterId) ? active.adapterId : undefined;
  const model = active?.model && MODEL_TOKEN.test(active.model) ? active.model : undefined;
  return {
    ...(adapter ? { adapter } : {}),
    ...(model ? { model } : {}),
    paneCount: Math.min(paneKeys.size, BUG_REPORT_LIMITS.maxPanes),
    missionActive: sessions.some((session) => Boolean(session.missionId)),
  };
}

interface ParsedEvent {
  event: BugReportDiagnosticEvent;
  failure: string | null;
}

function codeOf(record: Record<string, unknown>): string | undefined {
  for (const field of ['code', 'outcome'] as const) {
    const value = record[field];
    const text =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string'
          ? value
          : undefined;
    if (text !== undefined && CODE_TOKEN.test(text)) return text;
  }
  return undefined;
}

function failureLabel(kind: string, code: string | undefined): string | null {
  const failed =
    FAILURE_WORDS.test(kind) ||
    (code !== undefined && FAILURE_WORDS.test(code)) ||
    (/exit/i.test(kind) && code !== undefined && code !== '0');
  return failed ? (code ? `${kind}:${code}` : kind) : null;
}

function parseLine(raw: string): ParsedEvent | null {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const fields = record as Record<string, unknown>;
  const { kind, at } = fields;
  if (typeof kind !== 'string' || !KIND_TOKEN.test(kind)) return null;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return null;
  const code = codeOf(fields);
  return {
    event: { t: at, kind, ...(code === undefined ? {} : { code }) },
    failure: failureLabel(kind, code),
  };
}

/** NDJSON → eventos mínimos + erros curtos. Nunca lança. */
export function parseTraceTail(raw: string): Diagnostics {
  const parsed: ParsedEvent[] = [];
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const entry = parseLine(trimmed);
    if (entry) parsed.push(entry);
  }
  const events = parsed.slice(-BUG_REPORT_LIMITS.maxEvents).map((entry) => entry.event);
  const failures: string[] = [];
  for (const entry of parsed.slice(-ERROR_WINDOW)) {
    if (entry.failure && !failures.includes(entry.failure)) failures.push(entry.failure);
  }
  const errors = failures
    .slice(-BUG_REPORT_LIMITS.maxErrors)
    .map((failure) => failure.slice(0, BUG_REPORT_LIMITS.errorMax));
  return { events, errors };
}

/**
 * Lê os últimos `maxBytes` do arquivo. Quando o corte cai no meio do arquivo,
 * a primeira linha (provavelmente partida) é descartada.
 */
export async function readFileTail(file: string, maxBytes: number): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function buildDiagnostics(deps: DiagnosticsDeps): Promise<Diagnostics> {
  try {
    const tail = await deps.readTraceTail();
    return tail ? parseTraceTail(tail) : { events: [], errors: [] };
  } catch {
    // Diagnóstico é auxiliar: falha ao ler o trace nunca impede o relato.
    return { events: [], errors: [] };
  }
}

/** Fontes reais do Main. `require` tardio: o módulo continua testável sem Electron. */
export function createDefaultDiagnosticsDeps(): DiagnosticsDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron');
  const systemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string })
    .getSystemVersion?.();
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osVersion: systemVersion || os.release(),
    listAgentSessions: () =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('../pty/pty-manager') as typeof import('../pty/pty-manager')).listAgentSessions(),
    readTraceTail: async () => {
      const file = getTraceFilePath();
      return file ? readFileTail(file, TRACE_TAIL_BYTES) : null;
    },
  };
}
