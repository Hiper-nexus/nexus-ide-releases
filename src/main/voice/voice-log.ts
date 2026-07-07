import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Logger persistente do pipeline de voz. Escreve em ~/.nexus/logs/voice.log
 * (com rotação) E espelha no console — assim o dev vê no terminal e o app
 * empacotado deixa evidência em disco. Motivo: o `console.log` do processo
 * main do app empacotado NÃO vai parar no log unificado do macOS, e o do
 * renderer só vive no DevTools. Resultado: quando o mic do wake "ensaordece"
 * (troca de AirPods/sleep), a falha é invisível por construção. Este arquivo
 * fecha essa lacuna.
 *
 * Observabilidade NUNCA pode ser fonte de falha: todo erro de I/O é engolido
 * e degenera pra console — logger quebrado não pode derrubar a voz.
 */

export type VoiceLogLevel = 'info' | 'warn' | 'error';

export interface VoiceLogEntry {
  ts: string;
  level: VoiceLogLevel;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
}

/** Caminho padrão (display/diagnóstico). logVoice resolve o path a cada call. */
export const VOICE_LOG_FILE = path.join(os.homedir(), '.nexus', 'logs', 'voice.log');

/** Override de teste (NEXUS_VOICE_LOG_FILE) ou padrão. */
function resolveLogFile(): string {
  const override = process.env.NEXUS_VOICE_LOG_FILE;
  if (override) return override;
  return VOICE_LOG_FILE;
}

function resolveMaxBytes(): number {
  const n = Number(process.env.NEXUS_VOICE_LOG_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}

/** Formata uma entrada como uma linha de log (puro, sem I/O). */
export function formatVoiceLine(entry: VoiceLogEntry): string {
  let out = `${entry.ts} [${entry.level.toUpperCase()}] ${entry.event}`;
  if (entry.msg) out += `: ${entry.msg}`;
  if (entry.data && Object.keys(entry.data).length > 0) {
    out += ` ${JSON.stringify(entry.data)}`;
  }
  return out;
}

function consoleMirror(level: VoiceLogLevel, line: string): void {
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
}

/**
 * Anexa um evento ao voice.log (rotacionando se necessário) e espelha no
 * console. Falha silenciosamente — jamais propaga exceção.
 */
export function logVoice(
  level: VoiceLogLevel,
  event: string,
  msg?: string,
  data?: Record<string, unknown>,
): void {
  const line = formatVoiceLine({
    ts: new Date().toISOString(),
    level,
    event,
    msg,
    data,
  });
  consoleMirror(level, line);
  try {
    const file = resolveLogFile();
    const max = resolveMaxBytes();
    if (fs.existsSync(file) && fs.statSync(file).size >= max) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // observabilidade best-effort: não derrubar a voz por causa de log.
  }
}
