import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { VoiceLogPayload } from '../../shared/voice-ipc';

/**
 * Logger persistente do pipeline de voz. Escreve em ~/.nexus/logs/voice.log
 * (com rotação) e espelha no console — assim o dev vê no terminal e o app
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

/**
 * Eventos do pipeline cujo nome indica transcrição, ditado cru ou resposta gerada.
 * F-1424: defesa em profundidade no handler IPC — se um renderer enviar
 * o texto do usuário ou do assistente em `msg` ou em campos de `data`, o log
 * descarta o conteúdo sensível e preserva apenas metadados (ex.: contagem de caracteres).
 */
export const CONTENT_EVENT_PATTERN = /(?:transcript|raw|brainreply)/i;

/**
 * Mensagens descritivas estáticas permitidas em eventos de conteúdo.
 * Qualquer `msg` fora desta lista em um evento de conteúdo é tratada como
 * potencial vazamento de texto do operador/resposta e é redigida.
 */
export const SAFE_CONTENT_EVENT_MESSAGES: ReadonlySet<string> = new Set([
  'ditado transcrito',
  'transcrição bruta concluída',
  'transcrição realtime recebida',
  'transcrição classic recebida',
  'resposta do cérebro gerada',
]);

/**
 * Chaves em `data` que costumam carregar texto falado, transcrito ou gerado.
 */
export const SENSITIVE_DATA_KEY_PATTERN = /^(?:text|transcript|raw|final|say|lastUserTranscript)$/i;

/**
 * Sanitiza um evento de log vindo do renderer antes de encaminhar ao logger persistente.
 * Garante que textos do operador e da resposta nunca cheguem ao voice.log.
 */
export function sanitizeRendererVoiceEvent(payload: VoiceLogPayload): {
  level: VoiceLogLevel;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
} {
  const isContent = CONTENT_EVENT_PATTERN.test(payload.event);
  let msg = payload.msg;
  let data: Record<string, unknown> | undefined = payload.data ? { ...payload.data } : undefined;

  if (isContent) {
    if (msg && !SAFE_CONTENT_EVENT_MESSAGES.has(msg)) {
      if (!data) data = {};
      if (typeof data.chars !== 'number') {
        data.chars = msg.length;
      }
      msg = undefined;
    }
  }

  if (data) {
    for (const key of Object.keys(data)) {
      if (SENSITIVE_DATA_KEY_PATTERN.test(key)) {
        const val = data[key];
        if (typeof val === 'string') {
          if (typeof data.chars !== 'number') {
            data.chars = val.length;
          }
        }
        delete data[key];
      }
    }
  }

  return {
    level: payload.level,
    event: payload.event,
    msg,
    data,
  };
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

function appendVoiceLine(file: string, line: string, maxBytes: number): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // observabilidade best-effort: um destino não bloqueia o outro nem a voz.
  }
}

/**
 * Anexa um evento ao voice.log (rotacionando se necessário) e espelha no
 * console. O log é exclusivamente global: observabilidade do próprio Nexus
 * nunca pode criar arquivos dentro do projeto, sujar o Git ou contaminar uma
 * baseline greenfield. Falha silenciosamente — jamais propaga exceção.
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
  appendVoiceLine(resolveLogFile(), line, resolveMaxBytes());
}
