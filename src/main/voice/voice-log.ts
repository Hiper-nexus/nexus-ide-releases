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
 * Eventos do pipeline cujo nome indica transcrição, ditado cru, resposta
 * gerada ou resultado de ação/tool. F-1424: a sanitização vive DENTRO do
 * `logVoice` — todo chamador (Main direto ou handler IPC do renderer) passa
 * pelo mesmo gargalo antes de formatar, gravar no arquivo e espelhar no
 * console. O sanitize do IPC ficou sozinho na parte 1 e chamadores do Main
 * (live.toolLateResult) burlaram o filtro.
 */
export const CONTENT_EVENT_PATTERN =
  /(?:transcript|raw|reply|actionresult|toollateresult|incident)/i;

/**
 * Mensagens descritivas estáticas permitidas em eventos de conteúdo/ação.
 * Estratégia ALLOWLIST: nesses eventos o `msg` é não confiável por definição —
 * ele carrega transcrição, resposta gerada ou summary de tool (o executor
 * monta "browser aberto em <url ditada>"). Uma mensagem fora desta lista é
 * redigida e vira `data.chars`; uma mensagem da lista é literal de código,
 * sem interpolação, e passa inteira. Ao criar um evento novo da família
 * (nome contendo transcript/raw/reply/actionResult/toolLateResult/incident),
 * adicione aqui a literal EXATA usada no chamador — senão o log degrada para
 * chars (falha fechada, nunca vaza).
 */
export const SAFE_CONTENT_EVENT_MESSAGES: ReadonlySet<string> = new Set([
  // transcrição/ditado/resposta (parte 1)
  'ditado transcrito',
  'transcrição bruta concluída',
  'transcrição realtime recebida',
  'transcrição classic recebida',
  'resposta do cérebro gerada',
  'transcript de turno antigo descartado',
  'final antigo ignorado',
  'turno superado antes de falar',
  'síntese concluída em turno superado',
  'confirmação pendente sem energia acústica suficiente',
  'reply ruído/eco garbled descartado',
  'follow-up mudo — reabre escuta em vez de idle',
  'follow-up sem resposta Live — idle (sessão ainda quente se Live up)',
  // códigos de máquina do emptyReplyReason (cadeia de providers do cérebro)
  'noise-transcript',
  'provider-chain-deadline',
  'all-providers-failed',
  'provider-returned-empty',
  // resultado de ação/tool e incidentes (parte 2)
  'resultado de ação local',
  'resultado de ação realtime',
  'resultado tardio/duplicado não reenviado',
  'incidente de execução de ação',
]);

/**
 * Chaves em `data` que costumam carregar texto falado, transcrito ou gerado,
 * ou argumentos/sumários de ação/tool (url ditada, prompt, resposta do MCP).
 * Valor string vira `data.chars`; outros tipos são apenas removidos.
 */
export const SENSITIVE_DATA_KEY_PATTERN =
  /^(?:text|transcript|raw|final|say|lastUserTranscript|fingerprint|summary|url|args|prompt|query|message|content)$/i;

/**
 * Núcleo da defesa F-1424, aplicado dentro do `logVoice` para TODO chamador:
 * em evento de conteúdo/ação, `msg` fora da allowlist vira `data.chars`; em
 * qualquer evento, chaves sensíveis de `data` são descartadas (string preserva
 * o comprimento em `chars`). Falha fechada: prefere degradar o log a vazar.
 */
function sanitizeVoiceLogFields(
  event: string,
  msg?: string,
  data?: Record<string, unknown>,
): { msg?: string; data?: Record<string, unknown> } {
  let safeMsg = msg;
  let safeData: Record<string, unknown> | undefined = data ? { ...data } : undefined;

  if (
    CONTENT_EVENT_PATTERN.test(event) &&
    safeMsg &&
    !SAFE_CONTENT_EVENT_MESSAGES.has(safeMsg)
  ) {
    if (!safeData) safeData = {};
    if (typeof safeData.chars !== 'number') {
      safeData.chars = safeMsg.length;
    }
    safeMsg = undefined;
  }

  if (safeData) {
    for (const key of Object.keys(safeData)) {
      if (SENSITIVE_DATA_KEY_PATTERN.test(key)) {
        const val = safeData[key];
        if (typeof val === 'string' && typeof safeData.chars !== 'number') {
          safeData.chars = val.length;
        }
        delete safeData[key];
      }
    }
  }

  return { msg: safeMsg, data: safeData };
}

/**
 * Sanitiza um evento de log vindo do renderer antes de encaminhar ao logger
 * persistente. Garante que textos do operador e da resposta nunca cheguem ao
 * voice.log. Hoje é redundância consciente: `logVoice` também sanitiza (é o
 * gargalo único); a função fica exposta para o teste direto da regra.
 */
export function sanitizeRendererVoiceEvent(payload: VoiceLogPayload): {
  level: VoiceLogLevel;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
} {
  const { msg, data } = sanitizeVoiceLogFields(payload.event, payload.msg, payload.data);
  return { level: payload.level, event: payload.event, msg, data };
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
  // F-1424: gargalo único — Main e IPC passam por aqui antes do arquivo e do
  // console; nenhum chamador consegue burlar a redação.
  const { msg: safeMsg, data: safeData } = sanitizeVoiceLogFields(event, msg, data);
  const line = formatVoiceLine({
    ts: new Date().toISOString(),
    level,
    event,
    msg: safeMsg,
    data: safeData,
  });
  consoleMirror(level, line);
  appendVoiceLine(resolveLogFile(), line, resolveMaxBytes());
}
